import { useMemo, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";

import PageFrame from "../components/PageFrame.jsx";
import { auth0Enabled } from "../auth/auth0-config.js";
import { createPublicWorkspace, fetchBuyerMe, getAuthDefaults, requestBuyerOtp, verifyBuyerOtp } from "../auth/client.js";
import { writeSession } from "../auth/session.js";
import { Button, buttonClasses } from "../components/ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";

function titleFor(mode) {
  return mode === "signup" ? "Create your workspace" : "Sign in to your workspace";
}

function subtitleFor(mode) {
  return mode === "signup"
    ? "Start with policy-bounded autonomous spend and verifiable receipts."
    : "Access your operator workflows, receipts, and policy controls.";
}

function Auth0AuthPage({ mode }) {
  const { loginWithRedirect, isAuthenticated, isLoading, user } = useAuth0();
  const isSignup = mode === "signup";

  async function onContinue() {
    if (isAuthenticated) {
      window.location.href = "/app";
      return;
    }
    await loginWithRedirect({
      authorizationParams: isSignup ? { screen_hint: "signup" } : undefined,
      appState: { returnTo: "/app" }
    });
  }

  return (
    <PageFrame>
      <section className="section-shell auth-shell">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#7f2f1f]">Auth0</p>
            <CardTitle>{isSignup ? "Create your Settld account" : "Sign in to Settld"}</CardTitle>
            <CardDescription>
              {isSignup
                ? "Use your production identity provider flow with secure OIDC sessions."
                : "Continue with your Auth0 account to access operator workflows and controls."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isAuthenticated ? (
              <>
                <p className="text-sm font-medium text-[#275e55]">Authenticated as {user?.email ?? "your account"}.</p>
                <Button onClick={() => (window.location.href = "/app")}>Open workspace</Button>
              </>
            ) : (
              <Button onClick={onContinue} disabled={isLoading}>
                {isLoading ? "Preparing..." : isSignup ? "Continue with Auth0" : "Sign in with Auth0"}
              </Button>
            )}
            <p className="text-xs text-[#657185]">
              Configure `VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, and `VITE_AUTH0_AUDIENCE` in Vercel.
            </p>
            <p className="text-sm text-[#354152]">
              {isSignup ? "Already have an account? " : "Need an account? "}
              <a className="font-semibold text-[#7f2f1f]" href={isSignup ? "/login" : "/signup"}>
                {isSignup ? "Sign in" : "Create one"}
              </a>
            </p>
          </CardContent>
        </Card>
      </section>
    </PageFrame>
  );
}

export default function AuthPage({ mode = "login" }) {
  if (auth0Enabled) return <Auth0AuthPage mode={mode} />;

  const defaults = getAuthDefaults();
  const [fullName, setFullName] = useState("");
  const [company, setCompany] = useState("");
  const [tenantId, setTenantId] = useState(defaults.tenantId);
  const [apiBaseUrl, setApiBaseUrl] = useState(defaults.apiBaseUrl);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [signupComplete, setSignupComplete] = useState(false);

  const isSignup = mode === "signup";
  const emailOk = useMemo(() => {
    return /.+@.+\..+/.test(String(email));
  }, [email]);
  const canRequestCode = useMemo(() => {
    const currentEmailOk = /.+@.+\..+/.test(String(email));
    if (!currentEmailOk) return false;
    if (isSignup && String(company).trim().length < 2) return false;
    if (!isSignup && String(tenantId).trim().length < 2) return false;
    if (String(apiBaseUrl).trim().length < 1) return false;
    return true;
  }, [apiBaseUrl, company, email, isSignup, tenantId]);
  const canVerifyCode = useMemo(() => {
    if (!otpSent) return false;
    if (!emailOk) return false;
    if (String(code).trim().length < 4) return false;
    return true;
  }, [code, emailOk, otpSent]);

  async function onRequestCode(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!canRequestCode) {
      setError("Enter a valid email and workspace details.");
      return;
    }
    try {
      setLoading(true);
      let resolvedTenantId = String(tenantId).trim();
      if (isSignup && !signupComplete) {
        const signup = await createPublicWorkspace({
          apiBaseUrl,
          company,
          email,
          fullName,
          tenantId: resolvedTenantId
        });
        resolvedTenantId = typeof signup?.tenantId === "string" && signup.tenantId.trim() ? signup.tenantId.trim() : resolvedTenantId;
        if (resolvedTenantId) setTenantId(resolvedTenantId);
        setSignupComplete(true);
      }
      const issued = await requestBuyerOtp({
        apiBaseUrl,
        tenantId: resolvedTenantId,
        email
      });
      setOtpSent(true);
      setExpiresAt(typeof issued?.expiresAt === "string" ? issued.expiresAt : "");
      setNotice("Verification code sent. Check your inbox or SMTP sink.");
    } catch (err) {
      setError(err?.message ?? "Failed to send verification code.");
    } finally {
      setLoading(false);
    }
  }

  async function onVerifyCode(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!canVerifyCode) {
      setError("Enter the verification code to continue.");
      return;
    }
    try {
      setLoading(true);
      const verified = await verifyBuyerOtp({
        apiBaseUrl,
        tenantId,
        email,
        code
      });
      let role = typeof verified?.role === "string" ? verified.role : "viewer";
      let tenant = typeof verified?.tenantId === "string" ? verified.tenantId : tenantId;
      try {
        const me = await fetchBuyerMe({ apiBaseUrl });
        if (me?.principal) {
          role = typeof me.principal.role === "string" ? me.principal.role : role;
          tenant = typeof me.principal.tenantId === "string" ? me.principal.tenantId : tenant;
        }
      } catch {
        // Keep fallback values from login response.
      }
      writeSession({
        email,
        role,
        tenantId: tenant,
        apiBaseUrl,
        fullName,
        company,
        authMode: "buyer_otp"
      });
      window.location.href = "/app";
    } catch (err) {
      setError(err?.message ?? "Failed to verify code.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <PageFrame>
      <section className="section-shell auth-shell">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#7f2f1f]">{isSignup ? "Sign Up" : "Sign In"}</p>
            <CardTitle>{titleFor(mode)}</CardTitle>
            <CardDescription>{subtitleFor(mode)}</CardDescription>
          </CardHeader>

          <CardContent>
            <form className="grid gap-4" onSubmit={onRequestCode}>
              {isSignup ? (
                <label className="grid gap-2">
                  <Label>Full name</Label>
                  <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Aiden Lippert" />
                </label>
              ) : null}

              {isSignup ? (
                <label className="grid gap-2">
                  <Label>Company</Label>
                  <Input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Robotics" />
                </label>
              ) : null}

              <label className="grid gap-2">
                <Label>API base URL</Label>
                <Input
                  value={apiBaseUrl}
                  onChange={(e) => setApiBaseUrl(e.target.value)}
                  placeholder="/__settld or https://api.settld.work"
                  required
                />
              </label>

              <label className="grid gap-2">
                <Label>Tenant ID {isSignup ? "(optional, auto-generated if blank)" : ""}</Label>
                <Input value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="tenant_default" required={!isSignup} />
              </label>

              <label className="grid gap-2">
                <Label>Work email</Label>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
              </label>

              {error ? <p className="text-sm font-medium text-[#9e2f20]">{error}</p> : null}
              {notice ? <p className="text-sm font-medium text-[#275e55]">{notice}</p> : null}

              {!otpSent ? (
                <Button type="submit" disabled={!canRequestCode || loading}>
                  {loading ? "Sending code..." : "Send verification code"}
                </Button>
              ) : (
                <div className="rounded-xl border border-[#d8d0c1] bg-[rgba(255,253,248,0.85)] p-4">
                  <label className="grid gap-2">
                    <Label>Verification code</Label>
                    <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" required />
                  </label>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <Button type="button" disabled={!canVerifyCode || loading} onClick={onVerifyCode}>
                      {loading ? "Verifying..." : "Verify and continue"}
                    </Button>
                    <button type="submit" className={buttonClasses({ variant: "outline" })} disabled={loading}>
                      Resend code
                    </button>
                  </div>
                </div>
              )}

              {expiresAt ? <p className="text-xs text-[#657185]">Code expires at {new Date(expiresAt).toLocaleString()}.</p> : null}
              <p className="text-xs text-[#657185]">Buyer OTP uses an `HttpOnly` session cookie and your tenant domain policy.</p>
            </form>

            <p className="mt-6 text-sm text-[#354152]">
              {isSignup ? "Already have an account? " : "New to Settld? "}
              <a className="font-semibold text-[#7f2f1f]" href={isSignup ? "/login" : "/signup"}>
                {isSignup ? "Sign in" : "Create account"}
              </a>
            </p>
          </CardContent>
        </Card>
      </section>
    </PageFrame>
  );
}
