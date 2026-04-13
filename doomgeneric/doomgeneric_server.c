// doomgeneric_server.c - headless backend for cURL DOOM.
//
// File descriptors:
//   0 (stdin)    newline-terminated text commands from the Node parent.
//   1 (stdout)   redirected to stderr at startup, so doom's own printf
//                logging lands on the parent's stderr pipe.
//   2 (stderr)   doom's log output.
//   3            raw binary framebuffer (DOOMGENERIC_RESX *
//                DOOMGENERIC_RESY * sizeof(pixel_t) bytes per frame),
//                written whenever an 'F' command is received.
//
// Commands (one per line):
//   K <pressed> <keycode>   push a key event into doom's queue
//   T <n>                   advance the game by <n> tics
//   F                       dump the current framebuffer on fd 3
//   Q                       exit cleanly
//
// Time is virtualised: doom thinks one tic has elapsed between each call
// to doomgeneric_Tick(), regardless of wall-clock time. This lets us run
// tics as fast as we like, or not at all, without the engine drifting.

#include "doomgeneric/doomgeneric/doomgeneric.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define FRAME_FD 3

#define KEYQUEUE_SIZE 256

static unsigned short s_KeyQueue[KEYQUEUE_SIZE];
static unsigned int s_KeyQueueWriteIndex = 0;
static unsigned int s_KeyQueueReadIndex = 0;

// Virtual clock. Advances by (1000 / TICRATE) ms every time we want doom
// to run one tic. TICRATE is 35, so 1000/35 ≈ 28.57. we use 29 and doom's
// integer math rounds one tic per call.
#define MS_PER_TIC 29
static uint32_t virt_ms = 0;

void DG_Init(void) {}

void DG_DrawFrame(void) {
    // No-op. DG_ScreenBuffer already holds the latest frame. We dump it on
    // demand in response to an 'F' command.
}

void DG_SleepMs(uint32_t ms) {
    // Don't actually sleep. The engine asks for a delay inside its
    // "wait for next tic" loop. Advance our virtual clock instead so
    // the next I_GetTime() crosses a tic boundary and the loop exits.
    virt_ms += ms;
}

uint32_t DG_GetTicksMs(void) {
    return virt_ms;
}

int DG_GetKey(int* pressed, unsigned char* doomKey) {
    if (s_KeyQueueReadIndex == s_KeyQueueWriteIndex) {
        return 0;
    }
    unsigned short keyData = s_KeyQueue[s_KeyQueueReadIndex];
    s_KeyQueueReadIndex = (s_KeyQueueReadIndex + 1) % KEYQUEUE_SIZE;
    *pressed = (keyData >> 8) & 1;
    *doomKey = keyData & 0xFF;
    return 1;
}

void DG_SetWindowTitle(const char* title) {
    (void)title;
}

static void push_key(int pressed, unsigned int code) {
    unsigned short keyData = (unsigned short)(((pressed & 1) << 8) | (code & 0xFF));
    s_KeyQueue[s_KeyQueueWriteIndex] = keyData;
    s_KeyQueueWriteIndex = (s_KeyQueueWriteIndex + 1) % KEYQUEUE_SIZE;
}

static void run_tics(int n) {
    if (n < 1) n = 1;
    if (n > 4096) n = 4096;
    for (int i = 0; i < n; i++) {
        virt_ms += MS_PER_TIC;
        doomgeneric_Tick();
    }
}

static void dump_frame(void) {
    size_t n = (size_t)DOOMGENERIC_RESX * DOOMGENERIC_RESY * sizeof(pixel_t);
    const uint8_t* buf = (const uint8_t*)DG_ScreenBuffer;
    size_t written = 0;
    while (written < n) {
        ssize_t w = write(FRAME_FD, buf + written, n - written);
        if (w < 0) {
            if (errno == EINTR) continue;
            // Parent hung up. No point continuing.
            exit(0);
        }
        if (w == 0) break;
        written += (size_t)w;
    }
}

int main(int argc, char** argv) {
    // Doom writes its startup logs via printf() (stdout). We reserve stdout
    // for nothing and redirect it onto stderr so those logs reach the parent
    // via the stderr pipe instead of corrupting frame data on fd 3.
    if (dup2(STDERR_FILENO, STDOUT_FILENO) < 0) {
        perror("dup2");
        return 1;
    }
    setvbuf(stdout, NULL, _IOLBF, 0);
    setvbuf(stderr, NULL, _IOLBF, 0);

    // Confirm fd 3 is open. If the parent didn't plumb a frame pipe we
    // bail out loudly rather than silently dropping frames.
    if (write(FRAME_FD, "", 0) < 0) {
        fprintf(stderr, "doomgeneric_server: fd %d is not open. The parent "
                        "must pipe stdio[3] for frame output.\n", FRAME_FD);
        return 1;
    }

    doomgeneric_Create(argc, argv);

    // Run enough tics for the engine to finish its startup dance (level
    // load, screen wipe, first view refresh) so the first F command
    // returns a real in-game frame rather than an empty fade.
    run_tics(140);

    char line[128];
    while (fgets(line, sizeof(line), stdin)) {
        char cmd = line[0];
        switch (cmd) {
            case 'K': {
                int pressed = 0;
                unsigned int code = 0;
                if (sscanf(line + 1, " %d %u", &pressed, &code) == 2) {
                    push_key(pressed, code);
                }
                break;
            }
            case 'T': {
                int n = 1;
                sscanf(line + 1, " %d", &n);
                run_tics(n);
                break;
            }
            case 'F':
                dump_frame();
                break;
            case 'Q':
                return 0;
            default:
                // ignore blank lines, comments, garbage
                break;
        }
    }

    return 0;
}
