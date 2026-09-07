#import <Cocoa/Cocoa.h>
#import <OpenGL/gl3.h>
#include <mpv/client.h>
#include <mpv/render_gl.h>
#include <dlfcn.h>

// All entry points and rendering run on AppKit's main thread. Commands are
// asynchronous so the client cannot block the thread needed by its renderer.
static mpv_handle *player;
static mpv_render_context *renderer;
static NSString *session;
static NSString *lastError;
static BOOL stopping;

static id nodeValue(mpv_node *n) {
    switch(n->format) {
        case MPV_FORMAT_STRING: return n->u.string ? @(n->u.string) : @"";
        case MPV_FORMAT_FLAG: return @(n->u.flag != 0);
        case MPV_FORMAT_INT64: return @(n->u.int64);
        case MPV_FORMAT_DOUBLE: return isfinite(n->u.double_) ? @(n->u.double_) : [NSNull null];
        case MPV_FORMAT_NODE_ARRAY: {
            NSMutableArray *a = [NSMutableArray array];
            for(int i=0;i<n->u.list->num;i++) [a addObject:nodeValue(&n->u.list->values[i])];
            return a;
        }
        case MPV_FORMAT_NODE_MAP: {
            NSMutableDictionary *d = [NSMutableDictionary dictionary];
            for(int i=0;i<n->u.list->num;i++) d[@(n->u.list->keys[i])] = nodeValue(&n->u.list->values[i]);
            return d;
        }
        default: return [NSNull null];
    }
}
static int run(NSArray *args) {
    NSUInteger count = args.count;
    const char **argv = calloc(count+1,sizeof(char*));
    for(NSUInteger i=0;i<count;i++) {
        id v=args[i];
        NSString *s = [v isKindOfClass:NSString.class] ? v : [v description];
        argv[i]=strdup(s.UTF8String);
    }
    int result=mpv_command_async(player,0,argv);
    for(NSUInteger i=0;i<count;i++) free((void*)argv[i]);
    free(argv);
    if(result<0) lastError=@(mpv_error_string(result));
    return result;
}
static void *getProc(void *ctx,const char *name) { return dlsym(RTLD_DEFAULT,name); }
@interface LoomMpvView : NSOpenGLView
@end
static LoomMpvView *view;
@implementation LoomMpvView
- (BOOL)isOpaque { return YES; }
- (void)reshape { [super reshape]; [self.openGLContext update]; [self setNeedsDisplay:YES]; }
- (void)drawRect:(NSRect)rect {
    if(!renderer || stopping) return;
    [self.openGLContext makeCurrentContext];
    NSRect pixels=[self convertRectToBacking:self.bounds];
    mpv_opengl_fbo fbo={0,MAX(1,(int)pixels.size.width),MAX(1,(int)pixels.size.height),0};
    int flip=1, block=0;
    mpv_render_param params[]={{MPV_RENDER_PARAM_OPENGL_FBO,&fbo},{MPV_RENDER_PARAM_FLIP_Y,&flip},{MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME,&block},{0,NULL}};
    mpv_render_context_update(renderer);
    mpv_render_context_render(renderer,params);
    [self.openGLContext flushBuffer];
    mpv_render_context_report_swap(renderer);
}
@end
static void update(void *ctx) {
    dispatch_async(dispatch_get_main_queue(), ^{ if(view && !stopping) [view setNeedsDisplay:YES]; });
}
const char *loom_mpv_error(void) { return (lastError ?: @"libmpv could not start.").UTF8String; }
int loom_mpv_init(void) {
    if(!NSThread.isMainThread) {lastError=@"libmpv requires the main thread.";return -1;}
    if(player) return 0;
    player=mpv_create();
    if(!player) return -1;
    const char *opts[][2]={{"vo","libmpv"},{"config","no"},{"load-scripts","no"},{"terminal","no"},{"input-default-bindings","no"},{"input-vo-keyboard","no"},{"osd-level","0"},{"hwdec","auto-safe"},{"keep-open","yes"},{"idle","yes"}};
    for(size_t i=0;i<sizeof(opts)/sizeof(opts[0]);i++) mpv_set_option_string(player,opts[i][0],opts[i][1]);
    int result=mpv_initialize(player);
    if(result<0) {lastError=@(mpv_error_string(result));mpv_terminate_destroy(player);player=NULL;return result;}
    const char *properties[]={"time-pos","duration","pause","volume","mute","speed","track-list","eof-reached","video-params","audio-params","paused-for-cache","demuxer-cache-state","hwdec-current"};
    for(size_t i=0;i<sizeof(properties)/sizeof(properties[0]);i++) mpv_observe_property(player,i+1,properties[i],MPV_FORMAT_NODE);
    return 0;
}
int loom_mpv_start(void *parent,const char *source,const char *sessionId) {
    if(loom_mpv_init()<0 || !parent) return -1;
    if(!view) {
        NSOpenGLPixelFormatAttribute attrs[]={NSOpenGLPFAOpenGLProfile,NSOpenGLProfileVersion3_2Core,NSOpenGLPFADoubleBuffer,NSOpenGLPFAAccelerated,NSOpenGLPFAColorSize,24,NSOpenGLPFAAlphaSize,8,0};
        NSOpenGLPixelFormat *format=[[NSOpenGLPixelFormat alloc] initWithAttributes:attrs];
        view=[[LoomMpvView alloc] initWithFrame:((NSView*)parent).bounds pixelFormat:format];
        if(!view) {lastError=@"The libmpv OpenGL view could not be created.";return -1;}
        view.wantsBestResolutionOpenGLSurface=YES;
        [view.openGLContext makeCurrentContext];
        mpv_opengl_init_params gl={getProc,NULL};
        mpv_render_param params[]={{MPV_RENDER_PARAM_API_TYPE,MPV_RENDER_API_TYPE_OPENGL},{MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,&gl},{0,NULL}};
        int r=mpv_render_context_create(&renderer,player,params);
        if(r<0) {lastError=@(mpv_error_string(r));view=nil;return r;}
        mpv_render_context_set_update_callback(renderer,update,NULL);
    }
    // Drain events from the previous source before assigning a new session.
    while(mpv_wait_event(player,0)->event_id!=MPV_EVENT_NONE) {}
    session=@(sessionId);stopping=NO;
    [view removeFromSuperview];
    view.frame=((NSView*)parent).bounds;
    view.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
    [(NSView*)parent addSubview:view];
    [view.openGLContext update];
    return run(@[@"loadfile",@(source),@"replace"]);
}
int loom_mpv_command(const char *sessionId,const char *json) {
    if(!player || !session || ![session isEqualToString:@(sessionId)]) return -1;
    NSData *data=[@(json) dataUsingEncoding:NSUTF8StringEncoding];
    id args=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if(![args isKindOfClass:NSArray.class]) return -1;
    return run(args);
}
char *loom_mpv_poll(void) {
    if(!player || !session) return NULL;
    NSMutableArray *events=[NSMutableArray array];
    for(int i=0;i<128;i++) {
        mpv_event *event=mpv_wait_event(player,0);
        if(event->event_id==MPV_EVENT_NONE) break;
        mpv_node node;
        if(mpv_event_to_node(&node,event)>=0) {
            [events addObject:nodeValue(&node)];mpv_free_node_contents(&node);
        }
    }
    if(!events.count) return NULL;
    NSData *json=[NSJSONSerialization dataWithJSONObject:events options:0 error:nil];
    if(!json) return NULL;
    return strndup(json.bytes,json.length);
}
void loom_mpv_free(void *p) {free(p);}
int loom_mpv_stop(const char *sessionId) {
    if(!player || !session || (sessionId && ![session isEqualToString:@(sessionId)])) return 0;
    run(@[@"stop"]);stopping=YES;session=nil;[view removeFromSuperview];return 1;
}
void loom_mpv_shutdown(void) {
    loom_mpv_stop(NULL);
    if(renderer) { [view.openGLContext makeCurrentContext];mpv_render_context_free(renderer);renderer=NULL; }
    view=nil;
    if(player) {mpv_terminate_destroy(player);player=NULL;}
}
