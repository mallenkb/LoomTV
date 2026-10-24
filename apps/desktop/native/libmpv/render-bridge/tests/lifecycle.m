#import "../bridge.m"
#import <CoreGraphics/CoreGraphics.h>
#include <unistd.h>

@interface LMBackgroundTestWindow : NSWindow
@end
@implementation LMBackgroundTestWindow
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

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

static int realSwaps;
static void (*realReportSwap)(mpv_render_context *);
static void countedRealSwap(mpv_render_context *renderer) {
    realReportSwap(renderer);
    realSwaps++;
}
static void verifyRealPlayback(const char *runtime, const char *clip, NSView *host) {
    __weak LMView *releasedView;
    __weak NSOpenGLContext *releasedContext;
    @autoreleasepool {
        char error[512];
        void *opaque = loom_mpv_create(runtime, error, sizeof(error));
        check(opaque != NULL, error);
        LMEngine *value = (__bridge LMEngine *)opaque;
        check(value->api.mpv_set_property_string(value->player, "aid", "no") == 0, "Could not disable test audio.");
        check(value->api.mpv_set_property_string(value->player, "mute", "yes") == 0, "Could not mute test playback.");
        check(loom_mpv_attach(opaque, (__bridge void *)host, error, sizeof(error)) == 0, error);
        releasedView = value->view;
        releasedContext = value->view.openGLContext;
        realReportSwap = value->view->api.mpv_render_context_report_swap;
        value->view->api.mpv_render_context_report_swap = countedRealSwap;
        realSwaps = 0;
        int (*get)(mpv_handle *, const char *, mpv_format, void *) = dlsym(value->library, "mpv_get_property");
        void (*release)(void *) = dlsym(value->library, "mpv_free");
        check(get != NULL && release != NULL, "The bundled runtime lacks playback property APIs.");
        NSData *command = [NSJSONSerialization dataWithJSONObject:@[@"loadfile", @(clip), @"replace"] options:0 error:NULL];
        NSString *json = [[NSString alloc] initWithData:command encoding:NSUTF8StringEncoding];
        check(loom_mpv_command(opaque, 1, json.UTF8String, error, sizeof(error)) == 0, error);
        CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + 8.0;
        double position = 0;
        int64_t width = 0, height = 0;
        NSString *decoder = @"unavailable";
        BOOL verified = NO;
        while (CFAbsoluteTimeGetCurrent() < deadline) {
            @autoreleasepool {
                CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, false);
                char *events = loom_mpv_poll(opaque);
                if (events) {
                    NSData *data = [NSData dataWithBytes:events length:strlen(events)];
                    NSArray *batch = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
                    for (NSDictionary *event in batch) {
                        check(![event[@"event"] isEqual:@"bridge-error"], "The real render bridge reported an error.");
                        check(!([event[@"event"] isEqual:@"end-file"] && [event[@"reason"] isEqual:@"error"]), "The disposable clip could not decode.");
                        id commandError = event[@"error"];
                        BOOL failedCommand = [commandError isKindOfClass:NSString.class] && ![commandError isEqual:@"success"];
                        check(!([event[@"event"] isEqual:@"command-reply"] && failedCommand), "The real playback command failed.");
                    }
                    loom_mpv_free(events);
                }
                get(value->player, "time-pos", MPV_FORMAT_DOUBLE, &position);
                get(value->player, "video-params/w", MPV_FORMAT_INT64, &width);
                get(value->player, "video-params/h", MPV_FORMAT_INT64, &height);
                char *hardware = NULL;
                if (get(value->player, "hwdec-current", MPV_FORMAT_STRING, &hardware) == 0 && hardware) {
                    decoder = @(hardware);
                    release(hardware);
                }
                BOOL hardwareActive = [decoder isEqual:@"videotoolbox"] || [decoder isEqual:@"videotoolbox-copy"];
                if (position >= 0.2 && width > 0 && height > 0 && realSwaps >= 3 && hardwareActive) { verified = YES; break; }
            }
        }
        if (!verified) fprintf(stderr, "Real playback: time=%.3f size=%lldx%lld swaps=%d decoder=%s\n", position, (long long)width, (long long)height, realSwaps, decoder.UTF8String);
        check(verified, "Real background playback did not present VideoToolbox-decoded frames.");
        check(!NSApp.active && !host.window.keyWindow && !host.window.mainWindow
              && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != getpid(), "Real playback took foreground focus.");
        printf("PASS: real background playback %s, decoder=%s, size=%lldx%lld, time=%.3f, swaps=%d.\n", strrchr(clip, '/') ? strrchr(clip, '/') + 1 : clip, decoder.UTF8String, (long long)width, (long long)height, position, realSwaps);
        value = nil;
        check(loom_mpv_destroy(opaque) == 0, "Real playback teardown failed.");
        check(NSOpenGLContext.currentContext == nil && host.subviews.count == 0, "Real playback retained its drawable after closing.");
    }
    check(releasedView == nil && releasedContext == nil, "Real playback retained an AppKit or OpenGL owner.");
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        check([NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory], "The test could not disable its Dock presence.");
        check(!NSApp.active, "The background lifecycle test became active.");
        NSScreen *screen = nil;
        for (NSScreen *candidate in NSScreen.screens) {
            if (CGDisplayIsBuiltin([candidate.deviceDescription[@"NSScreenNumber"] unsignedIntValue])) { screen = candidate; break; }
        }
        // Opt-in integration tests never create a window on an external display.
        if (!screen) { puts("No built-in display is available."); return 77; }
        NSRect frame = NSMakeRect(screen.visibleFrame.origin.x + 60, screen.visibleFrame.origin.y + 60, 640, 480);
        NSWindow *window = [[LMBackgroundTestWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO screen:screen];
        window.releasedWhenClosed = NO;
        window.ignoresMouseEvents = YES;
        window.animationBehavior = NSWindowAnimationBehaviorNone;
        window.collectionBehavior = NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;
        window.level = CGWindowLevelForKey(kCGDesktopWindowLevelKey) + 1;
        [window setFrame:frame display:NO];
        check(window.screen == screen, "The test window left the built-in display.");
        // Allocate the drawable behind the user's windows without activation.
        [window orderBack:nil];
        check(!window.keyWindow && !window.mainWindow && !NSApp.active, "The test window took focus.");
        check(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != getpid(), "The test became the foreground application.");
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
        for (int clip = 2; clip < argc; clip++) verifyRealPlayback(argv[1], argv[clip], host);
        [window close];
        check(!NSApp.active, "The background lifecycle test became active during rendering.");
        puts("PASS: repeated teardown, duplicate attach and failed attach on the built-in display.");
    }
    return 0;
}
