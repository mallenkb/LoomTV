#ifndef LOOMTV_LIBMPV_BRIDGE_H
#define LOOMTV_LIBMPV_BRIDGE_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Draft ABI. Control calls for each engine must run serially on one worker.
 * The host's AppKit main run loop must remain free during attach and destroy.
 * Never accept the engine or NSView pointers from renderer JavaScript.
 */
uint32_t loom_mpv_bridge_version(void);
void *loom_mpv_create(const char *absolute_library_path, char *error, size_t capacity);
int loom_mpv_attach(void *engine, void *parent_nsview, char *error, size_t capacity);
int loom_mpv_command(void *engine, uint64_t request, const char *arguments_json,
                     char *error, size_t capacity);
/* Returns an allocated JSON array, or NULL when no events are queued. */
char *loom_mpv_poll(void *engine);
void loom_mpv_free(void *allocation);
/* Copies one JSON event batch into output and returns its byte length. */
int loom_mpv_poll_into(void *engine, char *output, size_t capacity);
/* Frees the renderer before the core; consumes the engine handle exactly once. */
void loom_mpv_destroy(void *engine);
#ifdef __cplusplus
}
#endif
#endif
