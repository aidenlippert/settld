import { useMemo, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";

import PageFrame from "../components/PageFrame.jsx";
import { auth0Enabled } from "../auth/auth0-config.js";
import { createPublicWorkspace, fetchBuyerMe, getAuthDefaults, requestBuyerOtp, verifyBuyerOtp } from "../auth/client.js";
import { writeSession } from "../auth/session.js";

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
        <article className="auth-card">
          <p className="eyebrow">Auth0</p>
          <h1>{isSignup ? "Create your Settld account" : "Sign in to Settld"}</h1>
          <p>
            {isSignup
              ? "Use your production identity provider flow with secure OIDC sessions."
              : "Continue with your Auth0 account to access operator workflows and controls."}
          </p>
          {isAuthenticated ? (
            <>
              <p className="auth-notice">Authenticated as {user?.email ?? "your account"}.</p>
              <button type="button" className="btn btn-solid" onClick={() => (window.location.href = "/app")}>
                Open workspace
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-solid" onClick={onContinue} disabled={isLoading}>
              {isLoading ? "Preparing..." : isSignup ? "Continue with Auth0" : "Sign in with Auth0"}
            </button>
          )}
          <p className="auth-meta">
            Configure `VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, and `VITE_AUTH0_AUDIENCE` in Vercel.
          </p>
          <p className="auth-switch">
            {isSignup ? "Already have an account? " : "Need an account? "}
            <a href={isSignup ? "/login" : "/signup"}>{isSignup ? "Sign in" : "Create one"}</a>
          </p>
        </article>
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
    const emailOk = /.+@.+\..+/.test(String(email));
    if (!emailOk) return false;
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
        <article className="auth-card">
          <p className="eyebrow">{isSignup ? "Sign Up" : "Sign In"}</p>
          <h1>{titleFor(mode)}</h1>
          <p>{subtitleFor(mode)}</p>

          <form className="auth-form" onSubmit={onRequestCode}>
            {isSignup ? (
              <label>
                <span>Full name</span>
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Aiden Lippert" />
              </label>
            ) : null}

            {isSignup ? (
              <label>
                <span>Company</span>
                <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Robotics" />
              </label>
            ) : null}

            <label>
              <span>API base URL</span>
              <input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="/__settld or https://api.settld.work" required />
            </label>

            <label>
              <span>Tenant ID {isSignup ? "(optional, auto-generated if blank)" : ""}</span>
              <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="tenant_default" required={!isSignup} />
            </label>

            <label>
              <span>Work email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
            </label>

            {error ? <p className="auth-error">{error}</p> : null}
            {notice ? <p className="auth-notice">{notice}</p> : null}

            {!otpSent ? (
              <button type="submit" className="btn btn-solid" disabled={!canRequestCode || loading}>
                {loading ? "Sending code..." : "Send verification code"}
              </button>
            ) : (
              <div className="auth-otp-panel">
                <label>
                  <span>Verification code</span>
                  <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" required />
                </label>
                <button type="button" className="btn btn-solid" disabled={!canVerifyCode || loading} onClick={onVerifyCode}>
                  {loading ? "Verifying..." : "Verify and continue"}
                </button>
                <button type="submit" className="btn btn-ghost" disabled={loading}>
                  Resend code
                </button>
              </div>
            )}

            {expiresAt ? <p className="auth-meta">Code expires at {new Date(expiresAt).toLocaleString()}.</p> : null}
            <p className="auth-meta">Buyer OTP uses an `HttpOnly` session cookie and your tenant domain policy.</p>
          </form>

          <p className="auth-switch">
            {isSignup ? "Already have an account? " : "New to Settld? "}
            <a href={isSignup ? "/login" : "/signup"}>{isSignup ? "Sign in" : "Create account"}</a>
          </p>
        </article>
      </section>
    </PageFrame>
  );
}
