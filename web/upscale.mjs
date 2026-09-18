// Catmull-Rom bicubic interpolation for browsers without canvas quality controls.
// Nine bilinear texture samples per output pixel; the GPU processes the frame.
export function createBicubicUpscaler() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false,
    preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  if (!gl) return null;
  const shaders = [];
  let program, buffer, texture;
  const dispose = () => {
    for (const shader of shaders) gl.deleteShader(shader);
    if (program) gl.deleteProgram(program);
    if (buffer) gl.deleteBuffer(buffer);
    if (texture) gl.deleteTexture(texture);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
  try {
    const compile = (type, source) => {
      const shader = gl.createShader(type); shaders.push(shader);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, `attribute vec2 position; varying vec2 uv;
      void main(){ uv=position*0.5+0.5; gl_Position=vec4(position,0.0,1.0); }`);
    const fragment = compile(gl.FRAGMENT_SHADER, `precision highp float;
      varying vec2 uv; uniform sampler2D image; uniform vec2 size; uniform vec4 region;
      void main(){
        vec2 pixel=(region.xy+vec2(uv.x,1.0-uv.y)*region.zw)*size;
        vec2 center=floor(pixel-0.5)+0.5, f=pixel-center;
        vec2 w0=f*(-0.5+f*(1.0-0.5*f));
        vec2 w1=1.0+f*f*(-2.5+1.5*f);
        vec2 w2=f*(0.5+f*(2.0-1.5*f));
        vec2 w3=f*f*(-0.5+0.5*f);
        vec2 w12=w1+w2;
        vec2 a=(center-1.0)/size, b=(center+w2/w12)/size, c=(center+2.0)/size;
        vec4 color=texture2D(image,vec2(a.x,a.y))*w0.x*w0.y
          +texture2D(image,vec2(b.x,a.y))*w12.x*w0.y
          +texture2D(image,vec2(c.x,a.y))*w3.x*w0.y
          +texture2D(image,vec2(a.x,b.y))*w0.x*w12.y
          +texture2D(image,vec2(b.x,b.y))*w12.x*w12.y
          +texture2D(image,vec2(c.x,b.y))*w3.x*w12.y
          +texture2D(image,vec2(a.x,c.y))*w0.x*w3.y
          +texture2D(image,vec2(b.x,c.y))*w12.x*w3.y
          +texture2D(image,vec2(c.x,c.y))*w3.x*w3.y;
        gl_FragColor=vec4(clamp(color.rgb,0.0,1.0),1.0);
      }`);
    program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
    texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const position = gl.getAttribLocation(program, 'position');
    const sizeLocation = gl.getUniformLocation(program, 'size');
    const regionLocation = gl.getUniformLocation(program, 'region');
    return { canvas, dispose,
      draw(video, crop, size) {
        if (gl.isContextLost()) return null;
        if (canvas.width !== size.width) canvas.width = size.width;
        if (canvas.height !== size.height) canvas.height = size.height;
        gl.viewport(0,0,canvas.width,canvas.height); gl.useProgram(program);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,video);
        gl.uniform2f(sizeLocation, video.videoWidth, video.videoHeight);
        gl.uniform4f(regionLocation,crop.x/video.videoWidth,crop.y/video.videoHeight,
          crop.width/video.videoWidth,crop.height/video.videoHeight);
        gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
        return canvas;
      } };
  } catch (error) { dispose(); console.warn('GPU zoom interpolation unavailable:', error.message); return null; }
}
