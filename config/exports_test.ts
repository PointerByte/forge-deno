// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  type CallOptions,
  ClientHTTP,
  type ClientOptions,
  GrpcClient,
  type GrpcContext,
  GrpcError,
  GrpcServer,
  type GrpcServerOptions,
  grpcStatus,
  type Handler,
  HttpClientError,
  httpContext,
  type HttpContextOptions,
  type HttpRequestContext,
  type HttpResponse,
  HttpServer,
  type HttpServerOptions,
  isValidTraceparent,
  isValidTracestate,
  loadProto,
  type LoadProtoOptions,
  type Middleware,
  newClientHTTP,
  newGrpcClient,
  newGrpcServer,
  newHttpServer,
  type RequestOptions,
  type Rest,
  RouteGroup,
  type ServerInterceptor,
  type ServiceHandlers,
  unary,
  type UnaryHandler,
} from "./mod.ts";
import * as focusedGrpc from "./grpc/mod.ts";
import * as focusedHttp from "./http/mod.ts";

Deno.test("aggregate config preserves existing runtime exports", () => {
  assertStrictEquals(ClientHTTP, focusedHttp.ClientHTTP);
  assertStrictEquals(HttpClientError, focusedHttp.HttpClientError);
  assertStrictEquals(HttpServer, focusedHttp.HttpServer);
  assertStrictEquals(RouteGroup, focusedHttp.RouteGroup);
  assertStrictEquals(newClientHTTP, focusedHttp.newClientHTTP);
  assertStrictEquals(newHttpServer, focusedHttp.newHttpServer);
  assertStrictEquals(httpContext, focusedHttp.httpContext);
  assertStrictEquals(isValidTraceparent, focusedHttp.isValidTraceparent);
  assertStrictEquals(isValidTracestate, focusedHttp.isValidTracestate);

  assertStrictEquals(GrpcClient, focusedGrpc.GrpcClient);
  assertStrictEquals(GrpcError, focusedGrpc.GrpcError);
  assertStrictEquals(GrpcServer, focusedGrpc.GrpcServer);
  assertStrictEquals(grpcStatus, focusedGrpc.status);
  assertStrictEquals(loadProto, focusedGrpc.loadProto);
  assertStrictEquals(newGrpcClient, focusedGrpc.newGrpcClient);
  assertStrictEquals(newGrpcServer, focusedGrpc.newGrpcServer);
  assertStrictEquals(unary, focusedGrpc.unary);
  assertEquals(grpcStatus[grpcStatus.INTERNAL], "INTERNAL");
});

Deno.test("aggregate config preserves existing type exports", () => {
  const surface: Partial<{
    callOptions: CallOptions;
    clientOptions: ClientOptions;
    grpcContext: GrpcContext;
    grpcServerOptions: GrpcServerOptions;
    handler: Handler;
    httpContextOptions: HttpContextOptions;
    httpRequestContext: HttpRequestContext;
    httpResponse: HttpResponse<unknown>;
    httpServerOptions: HttpServerOptions;
    loadProtoOptions: LoadProtoOptions;
    middleware: Middleware;
    requestOptions: RequestOptions;
    rest: Rest;
    serverInterceptor: ServerInterceptor;
    serviceHandlers: ServiceHandlers;
    unaryHandler: UnaryHandler;
  }> = {};

  assertEquals(surface, {});
});
