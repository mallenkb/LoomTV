#include <stdarg.h>
#include <stdio.h>

extern void loom_vlc_probe_record(void *probe, const char *message);

// LibVLC invokes this on its decoder threads. Formatting stays in C because
// va_list has platform-specific ABI details that Rust cannot express here.
void loom_vlc_probe_log_callback(void *probe, int level, const void *context,
                                  const char *format, va_list args) {
    (void)level;
    (void)context;
    if (!probe || !format) return;
    char message[1024];
    vsnprintf(message, sizeof message, format, args);
    message[sizeof message - 1] = '\0';
    loom_vlc_probe_record(probe, message);
}
