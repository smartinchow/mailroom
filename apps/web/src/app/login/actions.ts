"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  constantTimeStringEqual,
  createSessionToken,
} from "@/lib/session";

export async function login(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const expected = process.env.ADMIN_PASSWORD;
  const secret = process.env.WEB_SESSION_SECRET;

  if (!expected || !secret) {
    redirect("/login?error=config");
  }

  const ok = await constantTimeStringEqual(password, expected);
  if (!ok) {
    redirect("/login?error=1");
  }

  const token = await createSessionToken(secret);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  redirect("/");
}

export async function logout() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
