/*
 * A flash loader for EFR32 Series 2, to be run on the target's own CPU.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * ---- Why this exists, which is not obvious ------------------------------
 *
 * The browser flasher writes the nRF54L by poking its RRAM controller
 * registers straight over SWD, and the obvious thing to do here was the same
 * with the MSC. **It cannot be done: on this part the debug AP cannot reach
 * the peripheral bus at all.** Measured on a XIAO MG24, with the CPU halted
 * at reset and again with Zephyr running so every clock was already on:
 *
 *     0x20000000  SRAM      OK
 *     0xe000ed00  CPUID     OK
 *     0x08000000  flash     OK
 *     0x0fe08000  DEVINFO   OK
 *     0x50030000  MSC       REFUSED
 *     0x5005c000  USART0    REFUSED
 *     0x40030000  MSC (NS)  REFUSED
 *
 * Forcing CSW.HNONSEC clear (Secure access) changes nothing. So the MSC is
 * reachable only by code running on the CPU, which is exactly why OpenOCD and
 * pyOCD download an algorithm into RAM for this family rather than driving the
 * registers from the host. This is that algorithm.
 *
 * ---- The sequence -------------------------------------------------------
 *
 * Taken from Silicon Labs' own driver — `sl_hal_msc_erase_page()` and
 * `sl_hal_msc_write_burst()` in
 * modules/hal/silabs/simplicity_sdk/platform/peripheral/src/sl_hal_msc.c —
 * with register offsets from
 * .../Device/SiliconLabs/EFR32MG24/Include/efr32mg24_msc.h. Including the
 * double wait after a command, which the HAL comments as "We need to check
 * twice to be sure": the command is queued, so a single read can catch the
 * window between PENDING clearing and BUSY setting.
 *
 * ---- The MSC bus clock -------------------------------------------------
 *
 * The very first thing this does is set CMU_CLKEN1.MSC, and that is not
 * housekeeping: its reset value is 0, so out of reset the MSC register block
 * is not on the bus at all and the first access double-faults into lockup.
 * Measured, after the loader ran and immediately hard-faulted; with the clock
 * on, MSC_STATUS reads 0x09000008 (PWRON | WREADY | WDATAREADY) and
 * MSC_IPVERSION reads 3.
 *
 * ---- Two things that would be silent if wrong ---------------------------
 *
 *  - **This code must run from RAM.** Flash is not readable while it is being
 *    erased or programmed, so an instruction fetch from flash mid-operation
 *    hangs the bus. The HAL marks the same functions SL_HAL_MSC_CODE_RAM for
 *    this reason. The host loads this blob, its literal pool and its stack
 *    into SRAM.
 *  - **Interrupts must be off.** The vector table is in flash; a timer
 *    interrupt during an erase would fetch from unreadable memory. `cpsid i`
 *    is the first instruction, and nothing re-enables it — the part is reset
 *    when the flasher is done.
 *
 * ---- Calling convention -------------------------------------------------
 *
 *   r0  flash address. Page-aligned for ERASE; word-aligned for WRITE, and a
 *       WRITE must not cross a page boundary (the caller splits).
 *   r1  source buffer in SRAM (WRITE only)
 *   r2  word count (WRITE only)
 *   r3  0 = erase the page at r0, 1 = write r2 words from r1 to r0
 *
 *   returns r0 = 0 on success, else the offending MSC_STATUS bits
 *   (LOCKED | INVADDR | TIMEOUT | REGLOCK), so a failure names itself.
 *
 * Ends in `bkpt`, which halts the core with C_DEBUGEN set; the host waits for
 * DHCSR.S_HALT and then reads r0. The `b .` after it is not reachable in
 * normal operation and exists so a stray resume cannot run off into whatever
 * follows the blob.
 */

	.syntax unified
	.cpu cortex-m33
	.thumb

	/* Non-secure aliases, which is what Zephyr's own devicetree uses
	 * (flash-controller@50030000). On this part 0x4xxxxxxx is the *secure*
	 * alias and 0x5xxxxxxx the non-secure one — the opposite way round from
	 * the convention on some other vendors' TrustZone parts, and easy to
	 * assume backwards. With the SAU disabled out of reset both map to the
	 * same peripheral, so this is about matching the firmware, not about
	 * security. */
	.equ CMU,           0x50008000
	.equ O_CLKEN1,      0x068
	.equ CLKEN1_MSC,    (1 << 16)

	.equ MSC,           0x50030000
	.equ O_WRITECTRL,   0x00c
	.equ O_WRITECMD,    0x010
	.equ O_ADDRB,       0x014
	.equ O_WDATA,       0x018
	.equ O_STATUS,      0x01c
	.equ O_LOCK,        0x03c

	.equ LOCK_UNLOCK,   0x1b71
	.equ WREN,          0x1
	.equ ERASEPAGE,     0x2
	.equ WRITEEND,      0x4

	.equ ST_BUSY,       0x1
	.equ ST_WDATAREADY, 0x8
	.equ ST_PENDING,    0x20
	/* LOCKED | INVADDR | REGLOCK — everything that means "this did not
	 * happen". BUSY/PENDING/WDATAREADY are progress, not failure.
	 *
	 * **STATUS.TIMEOUT (0x40) is deliberately NOT here**, and that was
	 * measured rather than assumed. It is set at the end of *every* write
	 * burst on this part — the MSC closes its own write window rather than
	 * holding the programming voltage indefinitely — and it does not mean a
	 * word was lost. A full 8192-byte page written from this loader came back
	 * byte-for-byte identical with STATUS.TIMEOUT set, twice, at both 16
	 * words and 2048.
	 *
	 * Silicon Labs' own driver agrees by omission: sl_hal_msc_wait_status()
	 * inspects INVADDR, LOCKED and REGLOCK and never reads this bit. (Its
	 * SL_HAL_MSC_TIMEOUT return code is a *software* loop counter, which is a
	 * different thing wearing the same word.)
	 *
	 * Treating it as an error is what the first version of this file did, and
	 * it failed every successful write. */
	.equ ST_ERRORS,     0x00010006

	.thumb_func
	.global _start
_start:
	cpsid	i

	/* Turn the MSC's bus clock on. **Without this every MSC access from the
	 * CPU is a HardFault**, which is not obvious and cost a debugging round:
	 * CMU_CLKEN1.MSC is `_DEFAULT 0x00000000`, so out of reset the register
	 * block is simply not on the bus. It presents as an immediate double
	 * fault with pc=0xeffffffe (lockup) rather than as anything naming a
	 * clock — and the first thing it faults on is the MSC_LOCK write, which
	 * makes it look like a permission problem.
	 *
	 * Read-modify-write, not a bare store: CLKEN1 holds every other
	 * peripheral's bus clock too, and this loader must not switch anything
	 * else off underneath firmware that is about to be resumed.
	 *
	 * Left enabled on the way out. Zephyr's flash driver enables it anyway,
	 * and the flasher resets the part when it is done. */
	ldr	r5, =CMU
	ldr	r6, [r5, #O_CLKEN1]
	orr	r6, r6, #CLKEN1_MSC
	str	r6, [r5, #O_CLKEN1]

	ldr	r4, =MSC
	movw	r5, #LOCK_UNLOCK
	str	r5, [r4, #O_LOCK]
	movs	r5, #WREN
	str	r5, [r4, #O_WRITECTRL]

	cmp	r3, #0
	bne	.Lwrite

/* ---- erase the page at r0 ------------------------------------------- */
	str	r0, [r4, #O_ADDRB]
	movs	r5, #ERASEPAGE
	str	r5, [r4, #O_WRITECMD]
	bl	.Lwait_idle
	bl	.Lwait_idle
	b	.Ldone

/* ---- write r2 words from r1 to r0 ----------------------------------- */
.Lwrite:
	str	r0, [r4, #O_ADDRB]
	ldr	r6, [r4, #O_STATUS]
	ldr	r5, =ST_ERRORS
	tst	r6, r5
	bne	.Ldone			/* bad ADDRB: stop before writing */

.Lloop:
	cbz	r2, .Lloop_end
.Lready:
	/* The handshake the HAL performs per word. On the CPU it costs a few
	 * cycles, which is why it is here and not skipped: the reason the host
	 * could not do this itself is the whole point of the file. */
	ldr	r6, [r4, #O_STATUS]
	tst	r6, r5
	bne	.Ldone
	tst	r6, #ST_WDATAREADY
	beq	.Lready

	ldr	r7, [r1], #4
	str	r7, [r4, #O_WDATA]
	subs	r2, r2, #1
	b	.Lloop

.Lloop_end:
	movs	r5, #WRITEEND
	str	r5, [r4, #O_WRITECMD]
	bl	.Lwait_idle
	bl	.Lwait_idle

/* ---- report and relock ---------------------------------------------- */
.Ldone:
	ldr	r0, [r4, #O_STATUS]
	ldr	r5, =ST_ERRORS
	ands	r0, r0, r5
	movs	r5, #0
	str	r5, [r4, #O_WRITECTRL]
	str	r5, [r4, #O_LOCK]
	bkpt	#0
	b	.

.Lwait_idle:
	ldr	r6, [r4, #O_STATUS]
	tst	r6, #(ST_BUSY | ST_PENDING)
	bne	.Lwait_idle
	bx	lr

	.pool
	.end
