#import "../bridge.m"
#import <CoreGraphics/CoreGraphics.h>

static int freed, shutdowns, detached;
static void check(BOOL condition, const char *message) {
    if (!condition) { fprintf(stderr, "%s\n", message); exit(1); }
}
static int createRenderer(mpv_render_context **output, mpv_handle *player, mpv_render_param *params) {
    (void)player; (void)params;
    *output = (mpv_render_context *)1;
    return 0;
}
static int failRenderer(mpv_render_context **output, mpv_handle *player, mpv_render_param *params) {
    (void)output; (void)player; (void)params;
    check(NSOpenGLContext.currentContext != nil, "Attach did not make its GL context current.");
    return MPV_ERROR_UNSUPPORTED;
}
static void setCallback(mpv_render_context *renderer, void (*callback)(void *), void *context) {
    (void)renderer; (void)context;
    if (!callback) detached++;
}
static void freeRenderer(mpv_render_context *renderer) {
    (void)renderer;
    check(detached == freed + 1, "The update callback must detach before freeing its renderer.");
    check(NSOpenGLContext.currentContext != nil, "The renderer must be freed with its GL context current.");
    freed++;
}
static void shutdownPlayer(mpv_handle *player) { (void)player; shutdowns++; }
static uint64_t updateRenderer(mpv_render_context *renderer) { (void)renderer; return 0; }
static int render(mpv_render_context *renderer, mpv_render_param *params) {
    (void)renderer; (void)params;
    glClearColor(0, 0, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    return 0;
}
static void reportSwap(mpv_render_context *renderer) { (void)renderer; }
static LMEngine *engine(BOOL fail) {
    LMEngine *value = [LMEngine new];
    value->player = (mpv_handle *)1;
    value->api.mpv_render_context_create = fail ? failRenderer : createRenderer;
    value->api.mpv_render_context_set_update_callback = setCallback;
    value->api.mpv_render_context_free = freeRenderer;
    value->api.mpv_render_context_update = updateRenderer;
    value->api.mpv_render_context_render = render;
    value->api.mpv_render_context_report_swap = reportSwap;
    value->api.mpv_terminate_destroy = shutdownPlayer;
    return value;
}
static const char *errorString(int error) { (void)error; return "Expected renderer setup failure"; }

int main(int argc, const char **argv) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        NSScreen *screen = nil;
        for (NSScreen *candidate in NSScreen.screens) {
            if (CGDisplayIsBuiltin([candidate.deviceDescription[@"NSScreenNumber"] unsignedIntValue])) { screen = candidate; break; }
        }
        // Opt-in integration tests never create a window on an external display.
        if (!screen) { puts("No built-in display is available."); return 77; }
        NSRect frame = NSMakeRect(screen.visibleFrame.origin.x + 60, screen.visibleFrame.origin.y + 60, 640, 480);
        NSWindow *window = [[NSWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO screen:screen];
        window.releasedWhenClosed = NO;
        [window setFrame:frame display:NO];
        check(window.screen == screen, "The test window left the built-in display.");
        // Allocate the drawable behind the user's windows without activation.
        [window orderBack:nil];
        NSView *host = window.contentView;
        char error[512];
        if (argc > 1) {
            void *opaque = loom_mpv_create(argv[1], error, sizeof(error));
            check(opaque != NULL, error);
            LMEngine *real = (__bridge LMEngine *)opaque;
            int (*get)(mpv_handle *, const char *, mpv_format, void *) = dlsym(real->library, "mpv_get_property");
            check(get != NULL, "The bundled libmpv cannot report its decoder configuration.");
            int64_t threads = -1;
            int configured = get(real->player, "options/hwdec-threads", MPV_FORMAT_INT64, &threads);
            check((configured == 0 && threads == 1) || configured == MPV_ERROR_PROPERTY_NOT_FOUND,
                  "The bundled libmpv did not accept the hardware decoder thread limit.");
            check(get(real->player, "options/vd-lavc-threads", MPV_FORMAT_INT64, &threads) == 0 && threads == 0,
                  "The hardware decoder limit changed software fallback threading.");
            real = nil;
            check(loom_mpv_destroy(opaque) == 0, "The decoder configuration probe failed to close.");
        }
        __weak LMView *releasedView;
        __weak NSOpenGLContext *releasedContext;
        for (int cycle = 0; cycle < 3; cycle++) {
            @autoreleasepool {
                LMEngine *value = engine(NO);
                void *opaque = (__bridge_retained void *)value;
                check(loom_mpv_attach(opaque, (__bridge void *)host, error, sizeof(error)) == 0, "Renderer attach failed.");
                releasedView = value->view;
                releasedContext = value->view.openGLContext;
                check(NSEqualSizes(value->view.bounds.size, host.bounds.size), "A reopened renderer inherited the retired drawable size.");
                [value->view.openGLContext setView:value->view];
                [value->view.openGLContext update];
                [value->view.openGLContext makeCurrentContext];
                for (int staleError = 0; staleError < 16 && glGetError() != GL_NO_ERROR; staleError++) {}
                [value->view renderFrame];
                GLenum renderError = glGetError();
                if (renderError != GL_NO_ERROR) fprintf(stderr, "Native frame GL error: 0x%x\n", renderError);
                check(renderError == GL_NO_ERROR, "Presenting the native frame failed.");
                check(NSOpenGLContext.currentContext != nil, "Attached renderer has no current context.");
                check(loom_mpv_attach(opaque, (__bridge void *)host, error, sizeof(error)) < 0, "Duplicate attach was accepted.");
                check(value->view != nil && freed == cycle, "Rejecting duplicate attach disposed the active renderer.");
                value = nil;
                check(loom_mpv_destroy(opaque) == 0, "Destroy failed.");
                check(NSOpenGLContext.currentContext == nil, "Closing retained the current OpenGL context.");
                check(host.subviews.count == 0, "Closing retained the native render view.");
            }
            check(releasedView == nil, "The render view remained retained after closing.");
            check(releasedContext == nil, "The OpenGL context remained retained after closing.");
        }
        check(freed == 3 && shutdowns == 3, "Renderers and playback cores were not released exactly once.");
        @autoreleasepool {
            LMEngine *value = engine(YES);
            value->api.mpv_error_string = errorString;
            void *opaque = (__bridge_retained void *)value;
            check(loom_mpv_attach(opaque, (__bridge void *)host, error, sizeof(error)) < 0, "Expected attach failure was accepted.");
            check(value->view == nil, "Failed attach retained its render view.");
            check(NSOpenGLContext.currentContext == nil, "Failed attach retained its current GL context.");
            value = nil;
            loom_mpv_destroy(opaque);
        }
        check(freed == 3 && shutdowns == 4, "Failed attach did not release its core exactly once.");
        [window close];
        puts("PASS: repeated teardown, duplicate attach and failed attach on the built-in display.");
    }
    return 0;
}
