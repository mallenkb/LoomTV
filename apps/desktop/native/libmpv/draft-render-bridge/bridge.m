#import <Cocoa/Cocoa.h>
#import <OpenGL/gl3.h>
#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <mpv/client.h>
#include <mpv/render_gl.h>
#include <stdbool.h>
#include "bridge.h"

#define LM_API_TYPE MPV_RENDER_PARAM_API_TYPE
#define LM_GL_INIT MPV_RENDER_PARAM_OPENGL_INIT_PARAMS
#define LM_GL_FBO MPV_RENDER_PARAM_OPENGL_FBO
#define LM_FLIP_Y MPV_RENDER_PARAM_FLIP_Y
#define LM_BLOCK_FOR_TARGET_TIME MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME
#define LM_SKIP_RENDERING MPV_RENDER_PARAM_SKIP_RENDERING

// This bridge never starts a process. Each opaque engine owns one libmpv core,
// one event queue and at most one render context. Hosts own the surrounding
// LibVLC-compatible child view and must serialize control calls per engine.
#define LM_EXPORT __attribute__((visibility("default")))
#define LM_SYMBOLS(X) \
 X(unsigned long, mpv_client_api_version, (void)) \
 X(mpv_handle *, mpv_create, (void)) \
 X(int, mpv_initialize, (mpv_handle *)) \
 X(int, mpv_set_option_string, (mpv_handle *, const char *, const char *)) \
 X(int, mpv_command_async, (mpv_handle *, uint64_t, const char **)) \
 X(int, mpv_observe_property, (mpv_handle *, uint64_t, const char *, mpv_format)) \
 X(mpv_event *, mpv_wait_event, (mpv_handle *, double)) \
 X(int, mpv_event_to_node, (mpv_node *, mpv_event *)) \
 X(void, mpv_free_node_contents, (mpv_node *)) \
 X(const char *, mpv_error_string, (int)) \
 X(void, mpv_terminate_destroy, (mpv_handle *)) \
 X(int, mpv_render_context_create, (mpv_render_context **, mpv_handle *, mpv_render_param *)) \
 X(void, mpv_render_context_set_update_callback, (mpv_render_context *, void (*)(void *), void *)) \
 X(uint64_t, mpv_render_context_update, (mpv_render_context *)) \
 X(int, mpv_render_context_render, (mpv_render_context *, mpv_render_param *)) \
 X(void, mpv_render_context_report_swap, (mpv_render_context *)) \
 X(void, mpv_render_context_free, (mpv_render_context *))
typedef struct {
#define FIELD(result, name, args) result (*name) args;
 LM_SYMBOLS(FIELD)
#undef FIELD
} LMApi;

@class LMView;
@interface LMSignal : NSObject {
@public _Atomic(bool) pending;
}
@property(nonatomic, weak) LMView *view;
@end
@implementation LMSignal
@end

@interface LMView : NSOpenGLView {
@public LMApi api;
@public mpv_render_context *renderer;
@public _Atomic(int) renderError;
}
@property(nonatomic, strong) LMSignal *signal;
- (void)renderFrame;
@end

@interface LMEngine : NSObject {
@public LMApi api;
@public void *library;
@public mpv_handle *player;
@public LMView *view;
}
@end
@implementation LMEngine
- (void)dealloc {
    // destroy() must detach the renderer on AppKit's thread first.
    NSCAssert(view == nil, @"A libmpv renderer outlived its engine owner.");
    if (player) api.mpv_terminate_destroy(player);
    if (library) dlclose(library);
}
@end

static void copyError(char *output, size_t size, NSString *message) {
    if (output && size) snprintf(output, size, "%s", message.UTF8String ?: "libmpv failed.");
}
static void mainSync(dispatch_block_t block) {
    if (NSThread.isMainThread) block();
    else dispatch_sync(dispatch_get_main_queue(), block);
}
static void *getProc(void *context, const char *name) {
    (void)context;
    return dlsym(RTLD_DEFAULT, name);
}
static void renderUpdate(void *context) {
    @autoreleasepool {
        LMSignal *signal = (__bridge LMSignal *)context;
        if (atomic_exchange(&signal->pending, true)) return;
        dispatch_async(dispatch_get_main_queue(), ^{
            atomic_store(&signal->pending, false);
            [signal.view renderFrame];
        });
    }
}
@implementation LMView
- (BOOL)isOpaque { return YES; }
- (BOOL)acceptsFirstResponder { return NO; }
- (NSView *)hitTest:(NSPoint)point { (void)point; return nil; }
- (void)reshape {
    [super reshape];
    [self.openGLContext update];
    [self setNeedsDisplay:YES];
}
- (void)drawRect:(NSRect)rect { (void)rect; [self renderFrame]; }
- (void)renderFrame {
    if (!renderer) return;
    [self.openGLContext makeCurrentContext];
    api.mpv_render_context_update(renderer);
    NSRect pixels = [self convertRectToBacking:self.bounds];
    mpv_opengl_fbo fbo = {0, MAX(1, MIN(32768, (int)pixels.size.width)),
                            MAX(1, MIN(32768, (int)pixels.size.height)), 0};
    int flip = 1, block = 0;
    int skip = !self.window || !self.window.isVisible || self.window.isMiniaturized;
    mpv_render_param params[] = {
        {LM_GL_FBO, &fbo}, {LM_FLIP_Y, &flip},
        {LM_BLOCK_FOR_TARGET_TIME, &block}, {LM_SKIP_RENDERING, &skip}, {0, NULL}
    };
    int result = api.mpv_render_context_render(renderer, params);
    if (result < 0) { atomic_store(&renderError, result); return; }
    if (!skip) {
        [self.openGLContext flushBuffer];
        api.mpv_render_context_report_swap(renderer);
    }
}
@end

LM_EXPORT uint32_t loom_mpv_bridge_version(void) { return 1; }

// Call on a worker thread. No AppKit objects or playback surfaces are created
// here. The caller can keep one prepared, idle core ready for the next session.
LM_EXPORT void *loom_mpv_create(const char *path, char *error, size_t capacity) {
    @autoreleasepool {
        if (error && capacity) error[0] = '\0';
        if (!path || path[0] != '/') {
            copyError(error, capacity, @"libmpv requires an absolute library path.");
            return NULL;
        }
        LMEngine *engine = [LMEngine new];
        engine->library = dlopen(path, RTLD_NOW | RTLD_LOCAL);
        if (!engine->library) {
            const char *reason = dlerror();
            copyError(error, capacity, reason ? @(reason) : @"Could not load libmpv.");
            return NULL;
        }
#define LOAD(result, name, args) \
        engine->api.name = (result (*) args)dlsym(engine->library, #name); \
        if (!engine->api.name) { copyError(error, capacity, @"Missing libmpv symbol: " @#name); return NULL; }
        LM_SYMBOLS(LOAD)
#undef LOAD
        if ((engine->api.mpv_client_api_version() >> 16) != 2) {
            copyError(error, capacity, @"This bridge requires libmpv client API major version 2.");
            return NULL;
        }
        engine->player = engine->api.mpv_create();
        if (!engine->player) {
            copyError(error, capacity, @"libmpv could not allocate a playback core.");
            return NULL;
        }
        const char *options[][2] = {
            {"vo", "libmpv"}, {"config", "no"}, {"load-scripts", "no"},
            {"osc", "no"}, {"ytdl", "no"}, {"terminal", "no"},
            {"input-terminal", "no"}, {"input-default-bindings", "no"},
            {"input-vo-keyboard", "no"}, {"input-media-keys", "no"},
            {"idle", "yes"}, {"keep-open", "yes"}, {"force-window", "no"},
            {"osd-level", "0"}, {"audio-display", "no"}, {"hwdec", "auto-safe"},
            {"sub-auto", "no"}, {"audio-file-auto", "no"}, {"cover-art-auto", "no"},
            {"stop-screensaver", "no"}, {"video-timing-offset", "0"}
        };
        for (size_t i = 0; i < sizeof(options) / sizeof(options[0]); ++i) {
            int code = engine->api.mpv_set_option_string(engine->player, options[i][0], options[i][1]);
            if (code < 0) {
                copyError(error, capacity, [NSString stringWithFormat:@"libmpv option %s: %s", options[i][0], engine->api.mpv_error_string(code)]);
                return NULL;
            }
        }
        int code = engine->api.mpv_initialize(engine->player);
        if (code < 0) {
            copyError(error, capacity, @(engine->api.mpv_error_string(code)));
            return NULL;
        }
        const char *properties[] = {
            "time-pos", "duration", "pause", "volume", "mute", "speed", "track-list",
            "video-params", "hwdec-current", "frame-drop-count", "decoder-frame-drop-count",
            "demuxer-cache-duration", "paused-for-cache", "video-codec", "estimated-vf-fps",
            "eof-reached"
        };
        for (size_t i = 0; i < sizeof(properties) / sizeof(properties[0]); ++i) {
            code = engine->api.mpv_observe_property(engine->player, i + 1, properties[i], MPV_FORMAT_NODE);
            if (code < 0) {
                copyError(error, capacity, @(engine->api.mpv_error_string(code)));
                return NULL;
            }
        }
        return (__bridge_retained void *)engine;
    }
}

// parent is the existing native child host beneath the React controls, never
// an NSWindow or a pointer supplied by renderer JavaScript.
LM_EXPORT int loom_mpv_attach(void *opaque, void *parent, char *error, size_t capacity) {
    @autoreleasepool {
        if (!opaque || !parent) { copyError(error, capacity, @"The native video parent is missing."); return -1; }
        LMEngine *engine = (__bridge LMEngine *)opaque;
        __block int result = 0;
        mainSync(^{
            @try {
                if (engine->view) { result = -1; copyError(error, capacity, @"This engine already owns a renderer."); return; }
                NSView *host = (__bridge NSView *)parent;
                NSOpenGLPixelFormatAttribute attributes[] = {
                    NSOpenGLPFAOpenGLProfile, NSOpenGLProfileVersion3_2Core,
                    NSOpenGLPFADoubleBuffer, NSOpenGLPFAAccelerated,
                    NSOpenGLPFAColorSize, 24, NSOpenGLPFAAlphaSize, 8, 0
                };
                NSOpenGLPixelFormat *format = [[NSOpenGLPixelFormat alloc] initWithAttributes:attributes];
                if (!format) { result = -1; copyError(error, capacity, @"No supported OpenGL pixel format."); return; }
                LMView *view = [[LMView alloc] initWithFrame:host.bounds pixelFormat:format];
                if (!view || !view.openGLContext) { result = -1; copyError(error, capacity, @"Could not create the libmpv render view."); return; }
                view->api = engine->api;
                atomic_init(&view->renderError, 0);
                view.wantsBestResolutionOpenGLSurface = YES;
                view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
                [view.openGLContext makeCurrentContext];
                mpv_opengl_init_params gl = {getProc, NULL};
                mpv_render_param parameters[] = {{LM_API_TYPE, "opengl"}, {LM_GL_INIT, &gl}, {0, NULL}};
                result = engine->api.mpv_render_context_create(&view->renderer, engine->player, parameters);
                if (result < 0) { copyError(error, capacity, @(engine->api.mpv_error_string(result))); return; }
                engine->view = view;
                view.signal = [LMSignal new];
                LMSignal *signal = view.signal;
                atomic_init(&signal->pending, false);
                view.signal.view = view;
                [host addSubview:view positioned:NSWindowBelow relativeTo:nil];
                [view.openGLContext update];
                engine->api.mpv_render_context_set_update_callback(view->renderer, renderUpdate, (__bridge void *)view.signal);
            } @catch (NSException *exception) {
                result = -1;
                copyError(error, capacity, exception.reason ?: @"The native render view could not attach.");
            }
        });
        return result;
    }
}

static BOOL allowedCommand(NSArray *args) {
    if (args.count == 0 || args.count > 32 || ![args[0] isKindOfClass:NSString.class]) return NO;
    NSString *verb = args[0];
    // Authorization and typed property validation belong to the desktop host.
    // No script loading, shell commands, runtime reconfiguration or new windows.
    return [@[@"set_property", @"seek", @"loadfile", @"sub-add", @"stop"] containsObject:verb];
}
LM_EXPORT int loom_mpv_command(void *opaque, uint64_t request, const char *json, char *error, size_t capacity) {
    @autoreleasepool {
        if (!opaque || !json || strnlen(json, 2097153) > 2097152) { copyError(error, capacity, @"Invalid playback command."); return -1; }
        LMEngine *engine = (__bridge LMEngine *)opaque;
        NSData *data = [[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding];
        id value = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
        if (![value isKindOfClass:NSArray.class] || !allowedCommand(value)) { copyError(error, capacity, @"Unsupported playback command."); return -1; }
        NSArray *args = value;
        if ([args[0] isEqual:@"loadfile"] && !engine->view) { copyError(error, capacity, @"The native renderer must attach before loading media."); return -1; }
        NSMutableArray<NSString *> *strings = [NSMutableArray arrayWithCapacity:args.count];
        for (id argument in args) {
            NSString *text;
            if ([argument isKindOfClass:NSString.class]) text = argument;
            else if ([argument isKindOfClass:NSNumber.class] && isfinite([argument doubleValue])) {
                text = CFGetTypeID((__bridge CFTypeRef)argument) == CFBooleanGetTypeID() ? ([argument boolValue] ? @"yes" : @"no") : [argument stringValue];
            } else { copyError(error, capacity, @"Playback commands accept only strings and finite numbers."); return -1; }
            NSData *bytes = [text dataUsingEncoding:NSUTF8StringEncoding];
            if (bytes.length > 65536 || memchr(bytes.bytes, 0, bytes.length)) { copyError(error, capacity, @"Invalid command argument."); return -1; }
            [strings addObject:text];
        }
        const char **argv = calloc(strings.count + 1, sizeof(char *));
        if (!argv) { copyError(error, capacity, @"Could not allocate the playback command."); return -1; }
        for (NSUInteger i = 0; i < strings.count; ++i) argv[i] = strings[i].UTF8String;
        int code = engine->api.mpv_command_async(engine->player, request, argv);
        free(argv);
        if (code < 0) copyError(error, capacity, @(engine->api.mpv_error_string(code)));
        return code;
    }
}

static id nodeValue(const mpv_node *node, unsigned depth, unsigned *budget) {
    if (!node || depth > 24 || *budget == 0) return NSNull.null;
    --*budget;
    switch (node->format) {
        case MPV_FORMAT_STRING:
        case MPV_FORMAT_OSD_STRING: {
            if (!node->u.string) return @"";
            size_t size = strnlen(node->u.string, 65537);
            if (size > 65536) return NSNull.null;
            return [[NSString alloc] initWithBytes:node->u.string length:size encoding:NSUTF8StringEncoding] ?: NSNull.null;
        }
        case MPV_FORMAT_FLAG: return @(node->u.flag != 0);
        case MPV_FORMAT_INT64: return @(node->u.int64);
        case MPV_FORMAT_DOUBLE: return isfinite(node->u.double_) ? @(node->u.double_) : NSNull.null;
        case MPV_FORMAT_NODE_ARRAY:
        case MPV_FORMAT_NODE_MAP: {
            mpv_node_list *list = node->u.list;
            if (!list || list->num < 0 || list->num > 4096 || (list->num && !list->values)) return NSNull.null;
            if (node->format == MPV_FORMAT_NODE_ARRAY) {
                NSMutableArray *array = [NSMutableArray array];
                for (int i = 0; i < list->num && *budget; ++i) [array addObject:nodeValue(&list->values[i], depth + 1, budget)];
                return array;
            }
            if (list->num && !list->keys) return NSNull.null;
            NSMutableDictionary *map = [NSMutableDictionary dictionary];
            for (int i = 0; i < list->num && *budget; ++i) {
                if (!list->keys[i] || strnlen(list->keys[i], 513) > 512) continue;
                NSString *key = @(list->keys[i]);
                if (key) map[key] = nodeValue(&list->values[i], depth + 1, budget);
            }
            return map;
        }
        default: return NSNull.null;
    }
}
LM_EXPORT char *loom_mpv_poll(void *opaque) {
    @autoreleasepool {
        if (!opaque) return NULL;
        LMEngine *engine = (__bridge LMEngine *)opaque;
        NSMutableArray *events = [NSMutableArray array];
        for (unsigned i = 0; i < 128; ++i) {
            mpv_event *event = engine->api.mpv_wait_event(engine->player, 0);
            if (!event || event->event_id == MPV_EVENT_NONE) break;
            if (event->event_id == MPV_EVENT_QUEUE_OVERFLOW) { [events addObject:@{@"event": @"bridge-error", @"error": @"libmpv's event queue overflowed."}]; continue; }
            mpv_node node = {0};
            if (engine->api.mpv_event_to_node(&node, event) < 0) continue;
            unsigned budget = 8192;
            id converted = nodeValue(&node, 0, &budget);
            engine->api.mpv_free_node_contents(&node);
            if ([converted isKindOfClass:NSDictionary.class]) {
                NSMutableDictionary *row = [converted mutableCopy];
                if (event->reply_userdata) row[@"request_id"] = @(event->reply_userdata);
                if (event->error < 0) row[@"error"] = @(engine->api.mpv_error_string(event->error));
                [events addObject:row];
            }
        }
        // Hosts poll only while attached; attach/destroy are serialized with poll.
        LMView *view = engine->view;
        if (view) {
            int code = atomic_exchange(&view->renderError, 0);
            if (code < 0) [events addObject:@{@"event": @"bridge-error", @"error": @(engine->api.mpv_error_string(code))}];
        }
        if (!events.count) return NULL;
        NSData *data = [NSJSONSerialization dataWithJSONObject:events options:0 error:NULL];
        if (!data || data.length > 2097152) return strdup("[{\"event\":\"bridge-error\",\"error\":\"Native playback events exceeded the size limit.\"}]");
        return strndup(data.bytes, data.length);
    }
}
LM_EXPORT void loom_mpv_free(void *pointer) { free(pointer); }

// Call on a worker. AppKit detaches and frees the render context before the
// blocking core shutdown. A queued render callback owns only a weak view.
LM_EXPORT void loom_mpv_destroy(void *opaque) {
    if (!opaque) return;
    @autoreleasepool {
        LMEngine *engine = (__bridge_transfer LMEngine *)opaque;
        mainSync(^{
            LMView *view = engine->view;
            if (view) {
                view.signal.view = nil;
                [view.openGLContext makeCurrentContext];
                engine->api.mpv_render_context_set_update_callback(view->renderer, NULL, NULL);
                engine->api.mpv_render_context_free(view->renderer);
                view->renderer = NULL;
                [view removeFromSuperview];
                [view.openGLContext clearDrawable];
                engine->view = nil;
            }
        });
        // LMEngine dealloc now owns the only core and dlopen references.
    }
}
