// GPU-only video blur. Only the subtitle region is copied, never video pixels
// into JavaScript or CPU memory. All methods run on the render view's thread
// with its OpenGL context current. The mask is rebuilt only for layout changes.
@interface LMSubtitleBlur : NSObject {
    GLuint program, vao, textures[3], framebuffer;
    int textureWidth, textureHeight;
    NSRect copyRect;
    NSDictionary *layout;
    BOOL dirty, failed;
}
- (void)setLayout:(NSDictionary *)value;
- (void)renderWidth:(int)width height:(int)height;
- (void)dispose;
@end

static GLuint lmBlurShader(GLenum kind, const char *source) {
    GLuint shader = glCreateShader(kind);
    glShaderSource(shader, 1, &source, NULL);
    glCompileShader(shader);
    GLint ok = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
    if (!ok) { glDeleteShader(shader); return 0; }
    return shader;
}

// The same polygon and quadratic corners as StyledSubtitleText, with a
// top-left CSS origin. The mask limits blur to the joined text background.
static void lmBlurMask(CGContextRef context, NSArray *lines, CGFloat scaleX,
                       CGFloat scaleY, CGFloat offsetX, CGFloat offsetY, CGFloat radius) {
    CGPoint raw[130], points[130];
    size_t count = 0, size = lines.count;
    if (!size || size > 32) return;
    CGRect rects[32];
    for (size_t i = 0; i < size; i++) {
        NSDictionary *line = lines[i];
        rects[i] = CGRectMake([line[@"x"] doubleValue] * scaleX - offsetX,
                             [line[@"y"] doubleValue] * scaleY - offsetY,
                             [line[@"width"] doubleValue] * scaleX,
                             [line[@"height"] doubleValue] * scaleY);
    }
    raw[count++] = CGPointMake(CGRectGetMinX(rects[0]), CGRectGetMinY(rects[0]));
    raw[count++] = CGPointMake(CGRectGetMaxX(rects[0]), CGRectGetMinY(rects[0]));
    for (size_t i = 0; i < size; i++) {
        raw[count++] = CGPointMake(CGRectGetMaxX(rects[i]), CGRectGetMaxY(rects[i]));
        if (i + 1 < size) raw[count++] = CGPointMake(CGRectGetMaxX(rects[i + 1]), CGRectGetMaxY(rects[i]));
    }
    raw[count++] = CGPointMake(CGRectGetMinX(rects[size - 1]), CGRectGetMaxY(rects[size - 1]));
    for (size_t i = size; i-- > 0;) {
        raw[count++] = CGPointMake(CGRectGetMinX(rects[i]), CGRectGetMinY(rects[i]));
        if (i > 0) raw[count++] = CGPointMake(CGRectGetMinX(rects[i - 1]), CGRectGetMinY(rects[i]));
    }
    size_t unique = 0;
    for (size_t i = 0; i < count; i++) {
        if (!unique || !CGPointEqualToPoint(raw[i], points[unique - 1])) points[unique++] = raw[i];
    }
    if (unique > 1 && CGPointEqualToPoint(points[0], points[unique - 1])) unique--;
    count = 0;
    for (size_t i = 0; i < unique; i++) {
        CGPoint previous = points[(i + unique - 1) % unique], point = points[i], next = points[(i + 1) % unique];
        if ((previous.x == point.x && point.x == next.x) || (previous.y == point.y && point.y == next.y)) continue;
        raw[count++] = point;
    }
    if (count < 3) return;
    CGMutablePathRef path = CGPathCreateMutable();
    for (size_t i = 0; i < count; i++) {
        CGPoint previous = raw[(i + count - 1) % count], point = raw[i], next = raw[(i + 1) % count];
        CGFloat before = hypot(previous.x - point.x, previous.y - point.y);
        CGFloat after = hypot(next.x - point.x, next.y - point.y);
        CGFloat r = MIN(radius, MIN(before / 2, after / 2));
        CGPoint start = CGPointMake(point.x + (previous.x - point.x) * r / before,
                                    point.y + (previous.y - point.y) * r / before);
        CGPoint end = CGPointMake(point.x + (next.x - point.x) * r / after,
                                  point.y + (next.y - point.y) * r / after);
        if (i == 0) CGPathMoveToPoint(path, NULL, start.x, start.y);
        else CGPathAddLineToPoint(path, NULL, start.x, start.y);
        CGPathAddQuadCurveToPoint(path, NULL, point.x, point.y, end.x, end.y);
    }
    CGPathCloseSubpath(path);
    CGContextSetGrayFillColor(context, 1, 1);
    CGContextAddPath(context, path);
    CGContextFillPath(context);
    CGPathRelease(path);
}

@implementation LMSubtitleBlur
- (void)setLayout:(NSDictionary *)value {
    if ((layout == value) || [layout isEqual:value]) return;
    layout = [value copy];
    dirty = YES;
}
- (BOOL)prepareProgram {
    if (program) return YES;
    if (failed) return NO;
    const char *vertex = "#version 150\n"
        "out vec2 uv; void main(){ vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);"
        "uv=p; gl_Position=vec4(p*2.0-1.0,0,1); }";
    const char *fragment = "#version 150\n"
        "uniform sampler2D sourceImage,originalImage,shape; uniform vec2 stepUV;"
        "uniform int composite; in vec2 uv; out vec4 result;"
        "void main(){ vec4 sum=vec4(0); float total=0;"
        "for(int i=-8;i<=8;i++){float w=exp(-0.5*pow(float(i)/3.0,2.0));"
        "sum+=texture(sourceImage,uv+float(i)*stepUV)*w;total+=w;}"
        "vec4 blurred=sum/total; result=composite==0?blurred:"
        "mix(texture(originalImage,uv),blurred,texture(shape,uv).r); }";
    GLuint vs = lmBlurShader(GL_VERTEX_SHADER, vertex), fs = lmBlurShader(GL_FRAGMENT_SHADER, fragment);
    if (!vs || !fs) {
        if (vs) glDeleteShader(vs);
        if (fs) glDeleteShader(fs);
        failed = YES;
        NSLog(@"LoomTV subtitle blur shader did not compile.");
        return NO;
    }
    program = glCreateProgram();
    glAttachShader(program, vs); glAttachShader(program, fs);
    glBindFragDataLocation(program, 0, "result");
    glLinkProgram(program);
    glDeleteShader(vs); glDeleteShader(fs);
    GLint ok = 0;
    glGetProgramiv(program, GL_LINK_STATUS, &ok);
    if (!ok) {
        glDeleteProgram(program); program = 0; failed = YES;
        NSLog(@"LoomTV subtitle blur shader did not link.");
        return NO;
    }
    glGenVertexArrays(1, &vao);
    glGenTextures(3, textures);
    glGenFramebuffers(1, &framebuffer);
    return YES;
}
- (void)renderWidth:(int)width height:(int)height {
    if (!layout || ![self prepareProgram]) return;
    CGFloat cssWidth = [layout[@"width"] doubleValue], cssHeight = [layout[@"height"] doubleValue];
    NSArray *lines = layout[@"lines"];
    if (!(cssWidth > 0 && cssHeight > 0) || !lines.count || lines.count > 32) return;
    CGFloat sx = width / cssWidth, sy = height / cssHeight;
    CGFloat sigma = [layout[@"radius"] doubleValue] * MAX(sx, sy);
    if (!(sigma > 0 && sigma <= 192)) return;
    CGRect bounds = CGRectNull;
    for (NSDictionary *line in lines) {
        CGRect rect = CGRectMake([line[@"x"] doubleValue] * sx, [line[@"y"] doubleValue] * sy,
                                 [line[@"width"] doubleValue] * sx, [line[@"height"] doubleValue] * sy);
        bounds = CGRectUnion(bounds, rect);
    }
    // Three sigma of surrounding video prevents a hard sampling edge.
    bounds = CGRectIntersection(CGRectInset(bounds, -ceil(3 * sigma), -ceil(3 * sigma)), CGRectMake(0, 0, width, height));
    if (CGRectIsNull(bounds) || CGRectIsEmpty(bounds)) return;
    CGFloat x = floor(bounds.origin.x), top = floor(bounds.origin.y);
    int w = (int)ceil(CGRectGetMaxX(bounds) - x), h = (int)ceil(CGRectGetMaxY(bounds) - top);
    if (w <= 0 || h <= 0 || w > 16384 || h > 16384 || (size_t)w * h > 16777216) return;
    NSRect nextRect = NSMakeRect(x, height - top - h, w, h);
    if (!NSEqualRects(copyRect, nextRect)) dirty = YES;
    copyRect = nextRect;
    glActiveTexture(GL_TEXTURE0);
    if (textureWidth != w || textureHeight != h) {
        textureWidth = w; textureHeight = h; dirty = YES;
        for (int i = 0; i < 3; i++) {
            glBindTexture(GL_TEXTURE_2D, textures[i]);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            glTexImage2D(GL_TEXTURE_2D, 0, i == 2 ? GL_R8 : GL_RGBA8, w, h, 0,
                         i == 2 ? GL_RED : GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        }
    }
    if (dirty) {
        unsigned char *mask = calloc((size_t)w, (size_t)h);
        CGColorSpaceRef gray = CGColorSpaceCreateDeviceGray();
        CGContextRef context = mask ? CGBitmapContextCreate(mask, w, h, 8, w, gray, (CGBitmapInfo)kCGImageAlphaNone) : NULL;
        CGColorSpaceRelease(gray);
        if (!context) {
            free(mask); glBindTexture(GL_TEXTURE_2D, 0); return;
        }
        // Bitmap row zero becomes texture y=0. Flip CSS's top-left origin.
        CGContextTranslateCTM(context, 0, h);
        CGContextScaleCTM(context, 1, -1);
        lmBlurMask(context, lines, sx, sy, x, top, [layout[@"cornerRadius"] doubleValue] * MIN(sx, sy));
        glBindTexture(GL_TEXTURE_2D, textures[2]);
        glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
        glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, w, h, GL_RED, GL_UNSIGNED_BYTE, mask);
        glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
        CGContextRelease(context); free(mask); dirty = NO;
    }
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glReadBuffer(GL_BACK);
    glBindTexture(GL_TEXTURE_2D, textures[0]);
    glCopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, (int)copyRect.origin.x, (int)copyRect.origin.y, w, h);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, textures[1], 0);
    glDrawBuffer(GL_COLOR_ATTACHMENT0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
        glBindFramebuffer(GL_FRAMEBUFFER, 0); glBindTexture(GL_TEXTURE_2D, 0); return;
    }
    glDisable(GL_SCISSOR_TEST); glDisable(GL_BLEND); glDisable(GL_DEPTH_TEST);
    glUseProgram(program); glBindVertexArray(vao);
    glUniform1i(glGetUniformLocation(program, "sourceImage"), 0);
    glUniform1i(glGetUniformLocation(program, "originalImage"), 1);
    glUniform1i(glGetUniformLocation(program, "shape"), 2);
    glUniform1i(glGetUniformLocation(program, "composite"), 0);
    glUniform2f(glGetUniformLocation(program, "stepUV"), sigma / (3 * w), 0);
    glViewport(0, 0, w, h);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glDrawBuffer(GL_BACK);
    glBindTexture(GL_TEXTURE_2D, textures[1]);
    glActiveTexture(GL_TEXTURE1); glBindTexture(GL_TEXTURE_2D, textures[0]);
    glActiveTexture(GL_TEXTURE2); glBindTexture(GL_TEXTURE_2D, textures[2]);
    glUniform1i(glGetUniformLocation(program, "composite"), 1);
    glUniform2f(glGetUniformLocation(program, "stepUV"), 0, sigma / (3 * h));
    glViewport((int)copyRect.origin.x, (int)copyRect.origin.y, w, h);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    glBindVertexArray(0); glUseProgram(0);
    for (int i = 2; i >= 0; i--) { glActiveTexture(GL_TEXTURE0 + i); glBindTexture(GL_TEXTURE_2D, 0); }
}
- (void)dispose {
    if (framebuffer) glDeleteFramebuffers(1, &framebuffer);
    if (textures[0]) glDeleteTextures(3, textures);
    if (vao) glDeleteVertexArrays(1, &vao);
    if (program) glDeleteProgram(program);
    framebuffer = vao = program = 0;
    memset(textures, 0, sizeof(textures));
    textureWidth = textureHeight = 0;
}
@end
