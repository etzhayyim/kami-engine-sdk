declare module 'https://cdn.jsdelivr.net/npm/@met4citizen/headtts@1.2/+esm' {
  export class HeadTTS {
    constructor(options: {
      endpoints?: string[];
      languages?: string[];
    });
    onmessage?: (message: unknown) => void;
    connect(): Promise<void>;
    setup(options: {
      voice?: string;
      speed?: number;
    }): void;
    synthesize(options: {
      input: string;
    }): Promise<void>;
  }
}

interface GPU {
  requestAdapter(options?: Record<string, unknown>): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat(): GPUTextureFormat;
}

interface Navigator {
  gpu?: GPU;
}

interface GPUAdapter {
  requestDevice(descriptor?: Record<string, unknown>): Promise<GPUDevice>;
  requestAdapterInfo?(): Promise<GPUAdapterInfo>;
}

interface GPUAdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
}

interface GPUDevice {
  queue: GPUQueue;
  createShaderModule(descriptor: { code: string }): GPUShaderModule;
  createRenderPipeline(descriptor: Record<string, unknown>): GPURenderPipeline;
  createBuffer(descriptor: { size: number; usage: number }): GPUBuffer;
  createBindGroup(descriptor: Record<string, unknown>): GPUBindGroup;
  createCommandEncoder(): GPUCommandEncoder;
}

interface GPUQueue {
  writeBuffer(buffer: GPUBuffer, bufferOffset: number, data: BufferSource | SharedArrayBuffer): void;
  submit(commandBuffers: GPUCommandBuffer[]): void;
}

interface GPUShaderModule {}

interface GPURenderPipeline {
  getBindGroupLayout(index: number): GPUBindGroupLayout;
}

interface GPUBindGroupLayout {}

interface GPUBuffer {}

interface GPUBindGroup {}

interface GPUCommandEncoder {
  beginRenderPass(descriptor: Record<string, unknown>): GPURenderPassEncoder;
  finish(): GPUCommandBuffer;
}

interface GPUCommandBuffer {}

interface GPURenderPassEncoder {
  setPipeline(pipeline: GPURenderPipeline): void;
  setBindGroup(index: number, bindGroup: GPUBindGroup): void;
  setVertexBuffer(slot: number, buffer: GPUBuffer): void;
  draw(vertexCount: number): void;
  end(): void;
}

interface GPUCanvasContext {
  configure(descriptor: Record<string, unknown>): void;
  getCurrentTexture(): GPUTexture;
}

interface GPUTexture {
  createView(): GPUTextureView;
}

interface GPUTextureView {}

type GPUTextureFormat = string;

declare const GPUBufferUsage: {
  readonly COPY_DST: number;
  readonly UNIFORM: number;
  readonly VERTEX: number;
};
