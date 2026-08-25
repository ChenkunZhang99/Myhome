/** Security headers applied at the Worker boundary to every HTTP response. */

function localDevelopment(request: Request) {
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function contentSecurityPolicy(request: Request) {
  const development = localDevelopment(request);
  return [
    "default-src 'self'",
    // vinext injects inline hydration scripts. Vite HMR additionally needs
    // eval in local development; production responses never receive it.
    `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${development ? " http: ws:" : ""}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(development ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function withSecurityHeaders(response: Response, request: Request) {
  // Clone instead of mutating response.headers: Responses returned by a
  // binding fetch may carry an immutable header guard.
  const secured = new Response(response.body, response);
  secured.headers.set("Content-Security-Policy", contentSecurityPolicy(request));
  secured.headers.set("Strict-Transport-Security", "max-age=31536000");
  secured.headers.set("X-Content-Type-Options", "nosniff");
  secured.headers.set("X-Frame-Options", "DENY");
  secured.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  secured.headers.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  secured.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return secured;
}
