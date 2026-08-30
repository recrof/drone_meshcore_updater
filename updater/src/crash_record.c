/*
 * Carry a fatal error across the reset that follows it.
 *
 * ---- Why this file exists ------------------------------------------------
 *
 * prj.conf used to claim, and main.c used to repeat, that a Zephyr fault
 * "reaches /lfs1/LOG.NNNN because LOG_PANIC() flushes it synchronously". That
 * is exactly backwards, and it cost a day of looking for a dump that could
 * never have been there. Read `z_impl_log_panic()`:
 *
 *     STRUCT_SECTION_FOREACH(log_backend, backend) {
 *             if (log_backend_is_active(backend)) {
 *                     log_backend_panic(backend);      <-- FIRST
 *             }
 *     }
 *     while (log_process() == true) { }                <-- then flush
 *
 * and then the filesystem backend's own panic handler
 * (subsys/logging/backends/log_backend_fs.c):
 *
 *     static void panic(struct log_backend const *const backend)
 *     {
 *             log_backend_deactivate(backend);
 *     }
 *
 * The backend deactivates itself *before* the flush, deliberately — writing to
 * a filesystem from a fault context risks losing what is already on it. So the
 * flush drains to the console only, and it takes the deferred queue with it:
 * everything still buffered at the moment of the fault (up to
 * LOG_PROCESS_THREAD_SLEEP_MS of history) is dropped from flash too.
 *
 * On the nRF52840 the console is USB CDC, and the reset tears the USB device
 * down before a host reads a byte of it. So a fault there was *completely*
 * silent: nothing on the wire, nothing on flash, and a log file that simply
 * stopped mid-sentence. That is the shape of Trap 5 again — a log path that
 * quietly does not log.
 *
 * ---- Why a RAM record rather than writing the dump ------------------------
 *
 * The obvious fix is to write to flash from the handler, before LOG_PANIC()
 * turns the backend off. Do not: `k_sys_fatal_error_handler()` runs with
 * interrupts locked, littlefs takes a mutex, and if anything held that mutex
 * when the fault landed the device hangs instead of rebooting — trading a
 * reboot loop for a brick. Worse, the commonest fault here *is* a stack
 * overflow, and littlefs is the last thing to run on a stack that just ran out.
 *
 * So the handler only fills a `__noinit` struct — no locks, no drivers, a few
 * dozen bytes of stores — and the *next* boot logs it normally, on a healthy
 * system, into the file. `.noinit` is not cleared by the C startup code and
 * SRAM survives a soft reset on every part here; the magic guards against a
 * cold boot's garbage being read as a crash.
 *
 * ---- Why this replaces CONFIG_RESET_ON_FATAL_ERROR ------------------------
 *
 * That NCS symbol (nrf/lib/fatal_error) installs a *strong*
 * k_sys_fatal_error_handler of its own, so it cannot coexist with one here.
 * Its whole body is LOG_PANIC() + sys_arch_reboot(), which is the tail of this
 * one — the reboot behaviour Trap 7 needs is preserved exactly, it just no
 * longer happens before the evidence is saved. `CONFIG_REBOOT=y` is asserted
 * in prj.conf on its own account rather than inherited from that symbol's
 * `select`.
 */

#include "crash_record.h"

#include <zephyr/kernel.h>
#include <zephyr/fatal.h>
#include <zephyr/logging/log.h>
#include <zephyr/logging/log_ctrl.h>
#include <zephyr/sys/reboot.h>

#include <string.h>

LOG_MODULE_REGISTER(crash, LOG_LEVEL_INF);

/* Bumped if the struct layout ever changes, so a record written by the
 * previous firmware is ignored rather than misread. */
#define CRASH_MAGIC 0x43524832u   /* "CRH2" — bumped with the layout */

#define CRASH_NAME_MAX 24

struct crash_record {
	uint32_t magic;
	uint32_t reason;
	uint32_t pc;          /* 0 where the arch does not give us one */
	uint32_t lr;
	uint32_t cause;       /* Xtensa EXCCAUSE; unused elsewhere */
	uint32_t frame;       /* stacked exception frame = SP at the fault */
	uint32_t stack_start; /* 0 unless CONFIG_THREAD_STACK_INFO */
	uint32_t stack_size;
	uint32_t thread;      /* k_tid_t, for when the name is unavailable */
	uint32_t uptime_ms;
	char     name[CRASH_NAME_MAX];
};

/* Deliberately not `static`-initialised: `__noinit` is what keeps the C
 * startup code from clearing it, which is the entire mechanism. */
static __noinit struct crash_record s_rec;

/*
 * RISC-V mcause. The top bit separates interrupts from exceptions, and the
 * low bits are the code; only the exception codes are named, because an
 * interrupt arriving here at all is already the interesting part.
 */
static const char *riscv_cause_str(uint32_t cause)
{
	if (cause & 0x80000000U) {
		return "interrupt, not an exception";
	}
	switch (cause) {
	case 0:  return "instruction address misaligned";
	case 1:  return "instruction access fault";
	case 2:  return "illegal instruction";
	case 3:  return "breakpoint";
	case 4:  return "load address misaligned";
	case 5:  return "load access fault";
	case 6:  return "store/AMO address misaligned";
	case 7:  return "store/AMO access fault";
	case 11: return "environment call from M-mode";
	default: return "see the RISC-V privileged spec mcause table";
	}
}

/* The handful worth naming, out of the Xtensa ISA's EXCCAUSE table. Anything
 * not here prints as its number, which addr2line and the manual can finish. */
static const char *xtensa_cause_str(uint32_t cause)
{
	switch (cause) {
	case 0:  return "illegal instruction";
	case 2:  return "instr fetch error";
	case 3:  return "load/store error";
	case 5:  return "alloca";
	case 6:  return "divide by zero";
	case 9:  return "load/store alignment";
	case 20: return "instr fetch prohibited";
	case 28: return "load prohibited";
	case 29: return "store prohibited";
	default: return "see the Xtensa ISA EXCCAUSE table";
	}
}

static const char *reason_str(uint32_t reason)
{
	switch (reason) {
	case K_ERR_CPU_EXCEPTION:   return "CPU exception";
	case K_ERR_SPURIOUS_IRQ:    return "spurious IRQ";
	case K_ERR_STACK_CHK_FAIL:  return "STACK OVERFLOW";
	case K_ERR_KERNEL_OOPS:     return "kernel oops";
	case K_ERR_KERNEL_PANIC:    return "kernel panic";
	default:                    return "unknown";
	}
}

/*
 * Runs with interrupts locked, on a stack that may be the one that just
 * overflowed. Everything in here is plain stores into BSS-adjacent RAM: no
 * logging, no locks, no drivers, no allocation. `magic` is written last so a
 * second fault part-way through leaves the record invalid rather than
 * half-true.
 */
void k_sys_fatal_error_handler(unsigned int reason, const struct arch_esf *esf)
{
	struct k_thread *me = k_current_get();

	s_rec.magic       = 0;
	s_rec.reason      = reason;
	s_rec.uptime_ms   = (uint32_t)k_uptime_get();
	s_rec.thread      = (uint32_t)(uintptr_t)me;
	s_rec.pc          = 0;
	s_rec.lr          = 0;
	s_rec.cause       = 0;
	s_rec.frame       = (uint32_t)(uintptr_t)esf;
	s_rec.stack_start = 0;
	s_rec.stack_size  = 0;
	s_rec.name[0]     = '\0';

#if defined(CONFIG_CPU_CORTEX_M)
	if (esf != NULL) {
		s_rec.pc = esf->basic.pc;
		s_rec.lr = esf->basic.lr;
	}
#elif defined(CONFIG_XTENSA)
	/*
	 * Xtensa's `struct arch_esf` is literally `{ int dummy; }` — the real
	 * frame is variable-length and its layout lives in an arch-private
	 * header, so there is nothing portable to read out of `esf`. The
	 * registers are taken from where the exception left them instead:
	 * EPC1 is the faulting PC of a level-1 exception and EXCCAUSE is its
	 * cause, and nothing between the vector and here takes another
	 * level-1 exception to overwrite them.
	 *
	 * That is "in practice", not "by construction". A PC that is not a
	 * plausible code address should be treated as lost rather than as
	 * evidence — which is the whole reason the cause is recorded beside
	 * it, since the two disagreeing is the tell.
	 */
	s_rec.pc    = XTENSA_RSR("EPC1");
	s_rec.cause = XTENSA_RSR("EXCCAUSE");
#elif defined(CONFIG_RISCV)
	/*
	 * The best-behaved of the three. RISC-V's `struct arch_esf` is a real
	 * frame with named members, so `mepc` (the faulting PC) and `ra` (the
	 * return address, which is what the LR is called here) are read
	 * straight out of it — no live special registers, no "accurate in
	 * practice" caveat like the Xtensa arm above.
	 *
	 * `mcause` is the exception: it is only in the frame under
	 * CONFIG_CLIC_SUPPORT_INTERRUPT_LEVEL, which the ESP32-C5 does not
	 * set, so it is read from the CSR. That read is safe here for the same
	 * reason EPC1 is on Xtensa — nothing between the trap and this
	 * function takes another trap to overwrite it.
	 *
	 * **This arm was missing entirely until the C5 arrived**, and the way
	 * it failed is worth keeping: neither branch matched, so the record
	 * was still written and still reported, with pc, lr and cause all
	 * zero. `if (s_rec.pc != 0 || s_rec.lr != 0)` in the report then
	 * printed nothing at all — a crash report with the two most useful
	 * fields silently absent, which reads exactly like a crash that had no
	 * PC rather than a firmware that could not read one.
	 */
	if (esf != NULL) {
		s_rec.pc = (uint32_t)esf->mepc;
		s_rec.lr = (uint32_t)esf->ra;
	}
	{
		unsigned long mcause;

		__asm__ volatile ("csrr %0, mcause" : "=r" (mcause));
		s_rec.cause = (uint32_t)mcause;
	}
#endif

#if defined(CONFIG_THREAD_STACK_INFO)
	if (me != NULL) {
		s_rec.stack_start = (uint32_t)me->stack_info.start;
		s_rec.stack_size  = (uint32_t)me->stack_info.size;
	}
#endif

#if defined(CONFIG_THREAD_NAME)
	if (me != NULL) {
		const char *n = k_thread_name_get((k_tid_t)me);

		if (n != NULL) {
			strncpy(s_rec.name, n, sizeof(s_rec.name) - 1);
			s_rec.name[sizeof(s_rec.name) - 1] = '\0';
		}
	}
#endif

	s_rec.magic = CRASH_MAGIC;

	/* From here on this is NCS's fatal_error.c verbatim: say it on the
	 * console for whoever is watching one, then reboot so selfconfirm.c
	 * gets its chance to revert a bad image. */
	LOG_PANIC();
	LOG_ERR("Resetting system");
	sys_reboot(SYS_REBOOT_COLD);

	CODE_UNREACHABLE;
}

void crash_record_report(void)
{
	if (s_rec.magic != CRASH_MAGIC) {
		return;
	}
	s_rec.magic = 0;   /* reported once; a later clean boot says nothing */

	LOG_ERR("PREVIOUS RUN CRASHED: %s (reason %u) in thread %s (%p) "
		"after %u.%03u s",
		reason_str(s_rec.reason), s_rec.reason,
		s_rec.name[0] ? s_rec.name : "?",
		(void *)(uintptr_t)s_rec.thread,
		s_rec.uptime_ms / 1000U, s_rec.uptime_ms % 1000U);

	if (s_rec.pc != 0 || s_rec.lr != 0) {
		/* addr2line these against the zephyr.elf the board is running:
		 * the PC is where it died, the LR usually who called it. */
		LOG_ERR("  pc=0x%08x lr=0x%08x frame=0x%08x",
			s_rec.pc, s_rec.lr, s_rec.frame);
	}

	if (IS_ENABLED(CONFIG_XTENSA)) {
		/* The most informative number this architecture produces: it
		 * separates "dereferenced a bad pointer" from "ran off into
		 * memory that is not code", which on a part with no stack guard
		 * is the difference between a logic bug and an overflow. */
		LOG_ERR("  exccause=%u (%s)", s_rec.cause,
			xtensa_cause_str(s_rec.cause));
	} else if (IS_ENABLED(CONFIG_RISCV)) {
		/* Same job as exccause above. The ESP32-C5 has no hardware
		 * stack guard either (RISCV_PMP is unset on it), so telling a
		 * bad dereference from a run off the end of a stack is again
		 * the question this number answers. */
		LOG_ERR("  mcause=0x%08x (%s)", s_rec.cause,
			riscv_cause_str(s_rec.cause));
	}

	if (s_rec.stack_size != 0) {
		const uint32_t lo = s_rec.stack_start;
		const uint32_t hi = s_rec.stack_start + s_rec.stack_size;
		const bool     on_own_stack = (s_rec.frame >= lo && s_rec.frame < hi);

		/*
		 * Two different pictures, and reporting them as one is how the
		 * first version of this managed to print "11840 B left" about a
		 * stack that had just overflowed.
		 *
		 * When the frame is inside the thread's own stack, its distance
		 * from the bottom is the headroom that was left, and a small
		 * number is the answer.
		 *
		 * When it is *outside*, that is not a puzzle — it is the
		 * signature. An overflow trips the MPU guard during the
		 * hardware's own stacking, so the CPU takes the exception on
		 * the main stack instead and the frame we are handed lives
		 * there. A frame outside the faulting thread's stack means the
		 * thread had no room left to be pushed onto.
		 */
		if (on_own_stack) {
			LOG_ERR("  stack 0x%08x + %u B, %u B headroom left "
				"under the frame",
				lo, s_rec.stack_size, s_rec.frame - lo);
		} else {
			LOG_ERR("  stack 0x%08x + %u B — the frame is NOT on it, "
				"which is what a guard-region overflow looks "
				"like: raise this thread's stack",
				lo, s_rec.stack_size);
		}
	}
}
