/**
 * Centred single-card shell for the unauthenticated / interstitial routes
 * (/login, /change-password). It performs no session check -- see the note in
 * (dashboard)/layout.tsx: the gate and its redirect target must not share a
 * segment or the redirect loops.
 *
 * <main>, not <div>: these pages have no sidebar and no header, so without it
 * the whole route group had no landmark at all and a screen-reader user
 * landing on the forced /change-password interstitial had nothing to jump to.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      {children}
    </main>
  );
}
