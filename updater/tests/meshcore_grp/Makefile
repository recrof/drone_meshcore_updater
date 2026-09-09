# Host test for the MeshCore GRP_TXT encoder.
#
#   make        build and run
#   make vec    print one frame as hex, for the Go cross-check
#
# Nothing here is part of the firmware build; src/meshcore_grp.c is compiled
# again, unchanged, against the OpenSSL shim instead of the PSA one.

CFLAGS  = -std=c11 -Wall -Wextra -Werror -O1 -I../../src
LDLIBS  = -lcrypto
SRC     = ../../src/meshcore_grp.c crypto_openssl.c test_meshcore_grp.c

all: test
	./test

test: $(SRC) ../../src/meshcore_grp.h ../../src/meshcore_crypto.h
	$(CC) $(CFLAGS) -o $@ $(SRC) $(LDLIBS)

vec: test
	./test --emit "$(MSG)"

clean:
	rm -f test

.PHONY: all vec clean
