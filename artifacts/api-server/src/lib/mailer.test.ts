/**
 * Unit tests for the mailer seam — uses nodemailer's jsonTransport so no SMTP
 * server (or network) is involved. The org-name query is stubbed, so each test
 * controls whether the database returns an organization, returns none, or fails.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import nodemailer from "nodemailer";

const orgQuery = vi.hoisted(() => ({ rows: [] as Array<{ name: string }>, fail: false }));

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          limit: async () => {
            if (orgQuery.fail) throw new Error("database unavailable");
            return orgQuery.rows;
          },
        }),
      }),
    } as unknown as typeof actual.db,
  };
});

const TOKEN = "abc123token456";

function jsonTransport() {
  return nodemailer.createTransport({ jsonTransport: true });
}

describe("mailer", () => {
  let mailer: typeof import("./mailer");

  beforeAll(async () => {
    // @workspace/db throws at import when DATABASE_URL is unset; the query itself
    // is stubbed above, so any URL will do here.
    process.env.DATABASE_URL ||= "postgresql://nobody:nothing@127.0.0.1:9/nodb";
    mailer = await import("./mailer");
  });

  beforeEach(() => {
    process.env.APP_BASE_URL = "https://board.example.com";
    process.env.ORG_NAME = "Test Org";
    orgQuery.rows = [];
    orgQuery.fail = false;
    mailer._setTransportForTests(jsonTransport());
  });

  afterEach(() => {
    mailer._setTransportForTests(undefined); // back to env-resolved
    delete process.env.APP_BASE_URL;
  });

  it("is unconfigured when SMTP_HOST is unset (no-op sends)", async () => {
    mailer._setTransportForTests(null);
    expect(mailer.mailerConfigured()).toBe(false);
    const info = await mailer.sendPasswordResetEmail("a@b.c", "A", TOKEN);
    expect(info).toBeNull();
  });

  it("reset email contains the token link and product-neutral wording", async () => {
    const info: any = await mailer.sendPasswordResetEmail("user@example.com", "Ursula User", TOKEN);
    expect(info).toBeTruthy();
    const msg = JSON.parse(info.message);
    expect(msg.to[0].address).toBe("user@example.com");
    expect(msg.subject).toContain("Password reset");
    expect(msg.text).toContain(`https://board.example.com/reset-password?token=${TOKEN}`);
    expect(msg.html).toContain(`/reset-password?token=${TOKEN}`);
    // Product-neutral wording — org name from env/DB, no hardcoded brand.
    expect(msg.subject).toContain("Test Org");
    expect(msg.text).not.toMatch(/open board/i);
  });

  it("uses the organization name from the database when one exists", async () => {
    orgQuery.rows = [{ name: "Stored Org" }];
    const info: any = await mailer.sendPasswordResetEmail("user@example.com", "Ursula User", TOKEN);
    const msg = JSON.parse(info.message);
    expect(msg.subject).toContain("Stored Org");
    expect(msg.subject).not.toContain("Test Org");
  });

  it("falls back to ORG_NAME when the organization query fails", async () => {
    orgQuery.fail = true;
    const info: any = await mailer.sendPasswordResetEmail("user@example.com", "Ursula User", TOKEN);
    const msg = JSON.parse(info.message);
    expect(msg.subject).toContain("Test Org");
  });

  it("invite email contains the set-password link and NO password", async () => {
    const info: any = await mailer.sendInviteEmail("new@example.com", "Nina New", TOKEN);
    expect(info).toBeTruthy();
    const msg = JSON.parse(info.message);
    expect(msg.subject).toContain("account");
    expect(msg.text).toContain(`/reset-password?token=${TOKEN}`);
    // The invite must never carry a credential.
    expect(msg.text.toLowerCase()).not.toContain("one-time password");
    expect(msg.text).not.toMatch(/password is|password:\s/i);
    expect(msg.html).not.toMatch(/password is|password:\s/i);
  });

  it("swallows transport failures (never throws)", async () => {
    mailer._setTransportForTests({
      sendMail: async () => {
        throw new Error("SMTP down");
      },
    } as any);
    await expect(mailer.sendPasswordResetEmail("a@b.c", "A", TOKEN)).resolves.toBeNull();
    await expect(mailer.sendInviteEmail("a@b.c", "A", TOKEN)).resolves.toBeNull();
  });

  it("escapes HTML in names", async () => {
    const info: any = await mailer.sendPasswordResetEmail("x@y.z", `<script>alert(1)</script>`, TOKEN);
    const msg = JSON.parse(info.message);
    expect(msg.html).not.toContain("<script>");
    expect(msg.html).toContain("&lt;script&gt;");
  });
});
