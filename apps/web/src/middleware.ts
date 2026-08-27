import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const secret = process.env.WEB_SESSION_SECRET;

  const ok = Boolean(token && secret && (await verifySessionToken(secret, token)));
  if (!ok) {
    const loginUrl = new URL("/login", req.url);
    const res = NextResponse.redirect(loginUrl);
    if (token) res.cookies.delete(SESSION_COOKIE);
    return res;
  }
  return NextResponse.next();
}

export const config = {
  // Protect everything except /login and framework assets.
  matcher: ["/((?!login|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
