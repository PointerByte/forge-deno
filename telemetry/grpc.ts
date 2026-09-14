// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/** OpenTelemetry instrumentation for forge-deno's unary gRPC adapter. */

import { getMeter } from "./mod.ts";
import {
  context,
  SpanKind,
  type TextMapGetter,
  type TextMapSetter,
  trace,
} from "@opentelemetry/api";
import {
  extractContext,
  getOtelTracer,
  injectContext,
  recordOtelError,
  recordOtelSuccess,
} from "./internal.ts";
import type { GrpcContext, GrpcMetadata, ServerInterceptor } from "../config/grpc/contracts.ts";

/** Structural metadata surface needed for W3C propagation. */
export type GrpcMetadataCarrier = Pick<GrpcMetadata, "get" | "set" | "getMap">;

const tracer = getOtelTracer(`${"@pointerbyte/forge-deno"}/grpc`);
const meter = getMeter(`${"@pointerbyte/forge-deno"}/grpc`);
const serverDuration = meter.createHistogram("rpc.server.duration", {
  unit: "ms",
  description: "Duration of unary gRPC server calls.",
});
const clientDuration = meter.createHistogram("rpc.client.duration", {
  unit: "ms",
  description: "Duration of unary gRPC client calls.",
});

const metadataGetter: TextMapGetter<GrpcMetadataCarrier> = {
  keys(carrier): string[] {
    return Object.keys(carrier.getMap());
  },
  get(carrier, key): string[] | undefined {
    const values = carrier.get(key);
    if (values.length === 0) return undefined;
    return values.map((value) =>
      typeof value === "string" ? value : new TextDecoder().decode(value)
    );
  },
};

const metadataSetter: TextMapSetter<GrpcMetadataCarrier> = {
  set(carrier, key, value): void {
    carrier.set(key, value);
  },
};

/** Returns an interceptor that creates and propagates a SERVER span per unary RPC. */
export function grpcTelemetry(): ServerInterceptor {
  return async (ctx: GrpcContext, next: () => Promise<unknown>) => {
    const parent = extractContext(ctx.metadata, metadataGetter);
    const method = ctx.method || "grpc.unknown";
    const { service, operation } = splitMethod(method);
    const attributes = rpcAttributes(operation, service);
    const span = tracer.startSpan(method, {
      kind: SpanKind.SERVER,
      attributes,
    }, parent);
    const active = trace.setSpan(parent, span);
    const startedAt = performance.now();

    try {
      const result = await context.with(active, next);
      span.setAttribute("rpc.grpc.status_code", 0);
      recordOtelSuccess(span);
      return result;
    } catch (error) {
      const code = grpcErrorCode(error);
      span.setAttribute("rpc.grpc.status_code", code);
      recordOtelError(span, error);
      throw error;
    } finally {
      serverDuration.record(performance.now() - startedAt, attributes);
      span.end();
    }
  };
}

/** Runs a unary client call in a CLIENT span and injects W3C metadata. */
export async function withGrpcClientSpan<T>(
  method: string,
  address: string,
  metadata: GrpcMetadataCarrier,
  call: () => Promise<T>,
): Promise<T> {
  const parent = context.active();
  const operation = method || "grpc.unknown";
  const attributes = {
    ...rpcAttributes(operation),
    "server.address": address,
  };
  const span = tracer.startSpan(method, {
    kind: SpanKind.CLIENT,
    attributes,
  }, parent);
  const active = trace.setSpan(parent, span);
  injectContext(metadata, metadataSetter, active);
  const startedAt = performance.now();

  try {
    const result = await context.with(active, call);
    span.setAttribute("rpc.grpc.status_code", 0);
    recordOtelSuccess(span);
    return result;
  } catch (error) {
    const code = grpcErrorCode(error);
    span.setAttribute("rpc.grpc.status_code", code);
    recordOtelError(span, error);
    throw error;
  } finally {
    clientDuration.record(performance.now() - startedAt, attributes);
    span.end();
  }
}

function splitMethod(method: string): { service?: string; operation: string } {
  const normalized = method.startsWith("/") ? method.slice(1) : method;
  const separator = normalized.lastIndexOf("/");
  if (separator < 0) return { operation: normalized || "unknown" };
  return {
    service: normalized.slice(0, separator) || undefined,
    operation: normalized.slice(separator + 1) || "unknown",
  };
}

function rpcAttributes(operation: string, service?: string): Record<string, string> {
  return {
    "rpc.system": "grpc",
    "rpc.method": operation,
    ...(service ? { "rpc.service": service } : {}),
  };
}

function grpcErrorCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number" && Number.isFinite(code)) return code;
  }
  return 2;
}
