"use client";

// This page submits credentials to loginAction (./actions.ts), a Server
// Action that calls Auth.js's signIn("credentials", ...) server-side and
// returns { error } instead of throwing, per the Server Action invocation
// pattern documented in Plan 01-04's context (src/auth.ts exports signIn as
// a Server Action-compatible function).
import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loginAction } from "./actions";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const result = await loginAction(email, password);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Invalid email or password");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle asChild className="text-center text-2xl">
          <h1>Sign in to MSP PSA</h1>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/*
          method="post" is load-bearing, not decoration. A <form> with only an
          onSubmit handler falls back to the HTML default when submitted before
          React hydrates -- a GET to the current URL carrying every named field
          in the query string. That was observed putting a live password into
          the dev server's access log:
            GET /login?email=...&password=... 200
          which also means the URL bar, browser history and any referrer. POST
          keeps the credential in a body that goes nowhere, so a pre-hydration
          submit is merely inert instead of a credential leak.
        */}
        <form method="post" onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" disabled={isSubmitting} className="w-full">
            {isSubmitting ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
