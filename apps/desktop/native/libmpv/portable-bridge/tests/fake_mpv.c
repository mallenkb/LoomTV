#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    int wid_set;
    int initialized;
    int event_index;
} mpv_handle;

typedef struct mpv_node mpv_node;
typedef struct {
    int num;
    mpv_node *values;
    char **keys;
} mpv_node_list;
struct mpv_node {
    union {
        char *string;
        int flag;
        int64_t integer;
        double double_;
        mpv_node_list *list;
    } u;
    int format;
};
typedef struct {
    int event_id;
    int error;
    uint64_t reply_userdata;
    void *data;
} mpv_event;

unsigned long mpv_client_api_version(void) { return 2UL << 16; }
mpv_handle *mpv_create(void) { return calloc(1, sizeof(mpv_handle)); }
int mpv_set_option_string(mpv_handle *handle, const char *name, const char *value) {
    if (!handle || !name || !value) return -4;
    if (strcmp(name, "wid") == 0) handle->wid_set = strcmp(value, "4660") == 0;
    return 0;
}
int mpv_initialize(mpv_handle *handle) {
    if (!handle || !handle->wid_set) return -4;
    handle->initialized = 1;
    return 0;
}
int mpv_set_property_string(mpv_handle *handle, const char *name, const char *value) {
    if (!handle || !handle->initialized || !name || !value) return -4;
    return strcmp(value, "bad") == 0 ? -5 : 0;
}
int mpv_command_async(mpv_handle *handle, uint64_t request, const char **args) {
    (void)request;
    if (!handle || !handle->initialized || !args || !args[0]) return -4;
    return 0;
}
int mpv_observe_property(mpv_handle *handle, uint64_t request, const char *name, int format) {
    (void)request;
    return handle && handle->initialized && name && format == 6 ? 0 : -4;
}
mpv_event *mpv_wait_event(mpv_handle *handle, double timeout) {
    static mpv_event events[] = {{22, 0, 9, NULL}, {5, -5, 42, NULL}, {0, 0, 0, NULL}};
    (void)timeout;
    if (!handle || !handle->initialized) return NULL;
    if (handle->event_index < 2) return &events[handle->event_index++];
    return &events[2];
}
int mpv_event_to_node(mpv_node *node, mpv_event *event) {
    static char *keys[] = {"event", "name", "data"};
    static mpv_node values[3];
    static mpv_node_list list = {3, values, keys};
    if (!node || !event) return -4;
    values[0].format = 1;
    values[0].u.string = event->event_id == 5 ? "command-reply" : "property-change";
    values[1].format = 1;
    values[1].u.string = "hwdec-current";
    values[2].format = 1;
    values[2].u.string = "d3d11va";
    node->format = 8;
    node->u.list = &list;
    return 0;
}
void mpv_free_node_contents(mpv_node *node) { (void)node; }
const char *mpv_error_string(int error) { (void)error; return "mock error"; }
void mpv_terminate_destroy(mpv_handle *handle) { free(handle); }
