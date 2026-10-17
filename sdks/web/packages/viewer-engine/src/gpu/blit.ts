// The shaders the engine writes itself. None stands in for a game shader:
// `downsample` reproduces vkCmdBlitImage with VK_FILTER_LINEAR at a 2:1
// reduction, which WebGPU has no command for; `present` scales a finished
// view onto the caller's canvas.
//
// A capture keeps the executor's colour under alpha 0 (the PNG contract, so
// renderToPixels and the PNG export return it unchanged), but the canvas is
// configured with `alphaMode: "premultiplied"` and the compositor adds a
// premultiplied pixel to the page under it. The present blit therefore
// multiplies the colour by alpha; without it a transparent background shows
// as a grey box with coloured fringes on a dark page.
//
// The downsample reads the four source texels as UNORM bytes and does the
// sRGB decode, the mean and the encode in float32 with round-to-nearest. A
// bilinear sample of an sRGB view gives the same mean, but Apple's texture
// unit filters sRGB in reduced precision and differs from the exact result by
// one level on 12% of texels. The exact form matches a CPU model of the
// blit on 99.8% of texels, and that model fed through the executor's own
// compressor and scene reproduces the executor's PNG to 0.08/255 (W56).

const fullscreen = /* wgsl */ `
struct Out {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> Out {
  let corner = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  var out: Out;
  out.position = vec4<f32>(corner * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2<f32>(corner.x, 1.0 - corner.y);
  return out;
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linear: sampler;

@fragment
fn fs(in: Out) -> @location(0) vec4<f32> {
  let colour = textureSampleLevel(source, linear, in.uv, 0.0);
  return vec4<f32>(colour.rgb * colour.a, colour.a);
}
`;

const downsampleShader = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> srgb: vec4<u32>;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let corner = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(corner * 2.0 - 1.0, 0.0, 1.0);
}

fn decode(c: vec3<f32>) -> vec3<f32> {
  return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}

fn encode(l: vec3<f32>) -> vec3<f32> {
  return select(1.055 * pow(l, vec3<f32>(1.0 / 2.4)) - 0.055, l * 12.92, l <= vec3<f32>(0.0031308));
}

@fragment
fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(source));
  let base = vec2<i32>(position.xy) * 2;
  var sum = vec4<f32>(0.0);

  for (var index = 0; index < 4; index++) {
    let texel = min(base + vec2<i32>(index & 1, index >> 1), size - 1);
    let value = textureLoad(source, texel, 0);
    sum += select(value, vec4<f32>(decode(value.rgb), value.a), srgb.x == 1u);
  }

  let mean = sum * 0.25;
  let encoded = select(mean, vec4<f32>(encode(mean.rgb), mean.a), srgb.x == 1u);
  return round(clamp(encoded, vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0) / 255.0;
}
`;

export class Blitter {
  private readonly device: GPUDevice;

  private readonly module: GPUShaderModule;

  private readonly sampler: GPUSampler;

  private readonly pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();

  private downsamplePipeline: GPURenderPipeline | undefined;

  private readonly flags = new Map<boolean, GPUBuffer>();

  constructor(device: GPUDevice) {
    this.device = device;
    this.module = device.createShaderModule({ code: fullscreen });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  }

  private pipeline(format: GPUTextureFormat): GPURenderPipeline {
    const existing = this.pipelines.get(format);

    if (existing !== undefined) {
      return existing;
    }

    const pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.module, entryPoint: "vs" },
      fragment: { module: this.module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.pipelines.set(format, pipeline);

    return pipeline;
  }

  // Draws `source` (one mip level view) over all of `target`, premultiplied
  // for a canvas.
  present(
    encoder: GPUCommandEncoder,
    source: GPUTextureView,
    target: GPUTextureView,
    format: GPUTextureFormat,
  ): void {
    const pipeline = this.pipeline(format);
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source },
        { binding: 1, resource: this.sampler },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  // One 2:1 mip step of an RGBA8 chain. Both views are the chain's UNORM
  // view; `srgb` says the bytes are sRGB-encoded.
  downsample(
    encoder: GPUCommandEncoder,
    source: GPUTextureView,
    target: GPUTextureView,
    srgb: boolean,
  ): void {
    if (this.downsamplePipeline === undefined) {
      const module = this.device.createShaderModule({ code: downsampleShader });
      this.downsamplePipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
        primitive: { topology: "triangle-list" },
      });
    }

    let flag = this.flags.get(srgb);

    if (flag === undefined) {
      flag = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(flag, 0, new Uint32Array([srgb ? 1 : 0, 0, 0, 0]));
      this.flags.set(srgb, flag);
    }

    const bindGroup = this.device.createBindGroup({
      layout: this.downsamplePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source },
        { binding: 1, resource: { buffer: flag } },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] },
      ],
    });
    pass.setPipeline(this.downsamplePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }
}
