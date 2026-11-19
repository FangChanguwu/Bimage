import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { KeyRow } from "./types.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (status: number, message: string): HttpError =>
  new HttpError(status, message);
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail(400, "参数必须为对象");
  return value as Record<string, unknown>;
}
export const body = (request: Request): Record<string, unknown> =>
  object(request.body);
export const param = (request: Request, name = "id"): string =>
  String(request.params[name]);
export function user(request: Request): KeyRow {
  const identity: unknown = request.res?.locals.user;
  if (!identity) throw fail(401, "请登录");
  return identity as KeyRow;
}
export const admin: RequestHandler = (request, _response, next) => {
  if (user(request).role !== "admin") return next(fail(403, "需要管理员权限"));
  next();
};
export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (response.headersSent) {
    next(error);
    return;
  }
  const status = error instanceof HttpError ? error.status : 400;
  response.status(status).json({
    error:
      error instanceof Error && status < 500
        ? error.message
        : "请求失败，请检查参数或上游服务",
  });
}
