/*
 * A stand-in for FTDI's ftd2xx library, for `test/barco-ec.test.js`: the
 * eleven calls `devices/transports/ftdi.js` makes, answering as D2XX does for
 * one ordinary FTDI cable and one EC panel. The test compiles it with the
 * system C compiler (and skips without one), then drives the real D2XX
 * backend through koffi against it, so the prototypes, out-parameters and
 * async calls are exercised on a machine with no Windows and no panel.
 *
 * What a read returns is the last write with every byte inverted: enough to
 * see bytes go out and come back through the right buffers.
 */
#include <stdint.h>
#include <string.h>

typedef void *FT_HANDLE;
static int token;
static int opened = 0;
static uint8_t mode = 0;
static uint8_t latency = 0;
static uint8_t last[256];
static uint32_t lastLen = 0;

uint32_t FT_CreateDeviceInfoList(uint32_t *count) { *count = 2; return 0; }

uint32_t FT_GetDeviceInfoDetail(uint32_t index, uint32_t *flags, uint32_t *type, uint32_t *id, uint32_t *loc,
                                uint8_t *serial, uint8_t *description, FT_HANDLE *handle) {
  *flags = 0;
  *type = 8;
  *handle = 0;
  if (index == 0) {
    *id = 0x04036001; *loc = 0x11;
    strcpy((char *)serial, "FT0001"); strcpy((char *)description, "USB Serial Converter");
  } else {
    *id = 0x06000336; *loc = 0x21;
    strcpy((char *)serial, "EC50SN"); strcpy((char *)description, "EC Show Board");
  }
  return 0;
}

uint32_t FT_Open(int index, FT_HANDLE *handle) {
  if (index != 1) return 2;            /* FT_DEVICE_NOT_FOUND */
  *handle = &token; opened = 1; return 0;
}
static int ours(FT_HANDLE h) { return h == &token && opened; }
uint32_t FT_Close(FT_HANDLE h) { if (!ours(h)) return 1; opened = 0; return 0; }
uint32_t FT_ResetDevice(FT_HANDLE h) { return ours(h) ? 0 : 1; }
uint32_t FT_SetTimeouts(FT_HANDLE h, uint32_t readMs, uint32_t writeMs) { (void)readMs; (void)writeMs; return ours(h) ? 0 : 1; }
uint32_t FT_SetLatencyTimer(FT_HANDLE h, uint8_t ms) { latency = ms; return ours(h) ? 0 : 1; }
uint32_t FT_SetBitMode(FT_HANDLE h, uint8_t mask, uint8_t m) { (void)mask; mode = m; return ours(h) ? 0 : 1; }
uint32_t FT_Purge(FT_HANDLE h, uint32_t mask) { (void)mask; return ours(h) ? 0 : 1; }

uint32_t FT_Write(FT_HANDLE h, const uint8_t *buffer, uint32_t length, uint32_t *written) {
  if (!ours(h)) return 1;
  lastLen = length < sizeof last ? length : sizeof last;
  memcpy(last, buffer, lastLen);
  *written = length;
  return 0;
}

uint32_t FT_Read(FT_HANDLE h, uint8_t *buffer, uint32_t length, uint32_t *got) {
  if (!ours(h)) return 1;
  for (uint32_t i = 0; i < length; i++) buffer[i] = i < lastLen ? (uint8_t)(last[i] ^ 0xff) : 0;
  *got = length;
  return 0;
}

/* For the test to look at. */
uint8_t mock_mode(void) { return mode; }
uint8_t mock_latency(void) { return latency; }
int mock_opened(void) { return opened; }
