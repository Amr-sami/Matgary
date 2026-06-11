import "dotenv/config";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const BOOTSTRAP_EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL || "admin@matgary.com";
const BOOTSTRAP_PASSWORD = "12345678";

// Three plan defaults seeded into platform_plans so /api/plans (Spec 04) has
// rows to return immediately after 0034 applies. lib/payments/plans.ts stays
// as the typed fallback the route reads when the DB is unreachable.
const PLAN_SEED = [
  {
    key: "trial",
    label_ar: "تجربة مجانية",
    label_en: "Free trial",
    tagline_ar: "كل المميزات لمدة 14 يوم",
    tagline_en: "All features for 14 days",
    monthly_egp: 0,
    purchasable: false,
    features_ar: [
      "كل ميزات الباقة الاحترافية",
      "بدون بطاقة ائتمان",
      "تتحول للباقة المختارة بعد انتهاء الفترة",
    ],
    features_en: [
      "All Professional plan features",
      "No credit card required",
      "Switches to the chosen plan when the trial ends",
    ],
    sort_order: 0,
  },
  {
    key: "professional",
    label_ar: "احترافي",
    label_en: "Professional",
    tagline_ar: "متجر واحد — كل ما يحتاجه عملك",
    tagline_en: "Single store — everything your business needs",
    monthly_egp: 299,
    purchasable: true,
    features_ar: [
      "نقطة بيع، مخزون، فواتير، تقارير",
      "إدارة الموظفين والصلاحيات",
      "حضور وانصراف بالموقع الجغرافي",
      "إرسال الفواتير عبر WhatsApp",
      "نسخ احتياطي يومي تلقائي",
      "دعم فني على WhatsApp",
    ],
    features_en: [
      "POS, inventory, invoices, reports",
      "Team and permissions management",
      "GPS-based attendance tracking",
      "Send invoices over WhatsApp",
      "Automatic daily backups",
      "WhatsApp support",
    ],
    sort_order: 10,
  },
  {
    key: "multi_branch",
    label_ar: "متعدد الفروع",
    label_en: "Multi-branch",
    tagline_ar: "قريباً — لإدارة أكثر من فرع",
    tagline_en: "Coming soon — to manage more than one store",
    monthly_egp: 0,
    purchasable: false,
    features_ar: [
      "كل مميزات الباقة الاحترافية",
      "إدارة عدة فروع من نفس الحساب",
      "تقارير موحَّدة بين الفروع",
      "تحويل المخزون بين الفروع",
    ],
    features_en: [
      "All Professional plan features",
      "Manage multiple branches from one account",
      "Unified cross-branch reports",
      "Transfer inventory between branches",
    ],
    sort_order: 20,
  },
] as const;

async function ensureAdminRole(sql: ReturnType<typeof postgres>) {
  // Idempotent DB-role creation. The role gets BYPASSRLS so admin queries
  // see every tenant. Tenant-facing code keeps using matgary_app (no bypass).
  // ADMIN_DB_PASSWORD is read from env so the SQL never carries a credential.
  const adminPassword = process.env.ADMIN_DB_PASSWORD || "matgary_admin";
  // Postgres can't parametrise role names or passwords in a regular query —
  // we need to interpolate. Both values are constrained to safe shapes
  // (env-controlled or default) so this is acceptable.
  const safeName = "matgary_admin";
  const safePw = adminPassword.replace(/'/g, "''");
  await sql.unsafe(`
    DO $$ BEGIN
      CREATE ROLE ${safeName} LOGIN PASSWORD '${safePw}';
    EXCEPTION WHEN duplicate_object THEN
      ALTER ROLE ${safeName} WITH LOGIN PASSWORD '${safePw}';
    END $$;
  `);
  await sql.unsafe(`ALTER ROLE ${safeName} BYPASSRLS;`);
  await sql.unsafe(`GRANT CONNECT ON DATABASE matgary TO ${safeName};`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${safeName};`);
  await sql.unsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${safeName};`,
  );
  await sql.unsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${safeName};`,
  );
  await sql.unsafe(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${safeName};`,
  );
  await sql.unsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${safeName};`,
  );
}

async function seedBootstrapAdmin(sql: ReturnType<typeof postgres>) {
  // bcrypt cost 12 — matches the spec rules. Generated in-process so the
  // SQL migration file never carries a credential.
  const hash = await bcrypt.hash(BOOTSTRAP_PASSWORD, 12);
  await sql`
    INSERT INTO admins (email, password_hash, display_name, role, must_rotate)
    VALUES (${BOOTSTRAP_EMAIL}, ${hash}, 'Platform Admin', 'super_admin', true)
    ON CONFLICT (email) DO NOTHING
  `;
}

async function seedPlatformPlans(sql: ReturnType<typeof postgres>) {
  for (const p of PLAN_SEED) {
    await sql`
      INSERT INTO platform_plans (
        key, label_ar, label_en, tagline_ar, tagline_en,
        monthly_egp, purchasable, features_ar, features_en, sort_order
      ) VALUES (
        ${p.key}, ${p.label_ar}, ${p.label_en}, ${p.tagline_ar}, ${p.tagline_en},
        ${p.monthly_egp}, ${p.purchasable},
        ${sql.array(p.features_ar as unknown as string[])},
        ${sql.array(p.features_en as unknown as string[])},
        ${p.sort_order}
      )
      ON CONFLICT (key) DO NOTHING
    `;
  }
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(sql);
  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "lib/db/migrations" });
  console.log("Migrations complete.");

  // Idempotent post-DDL steps for the platform-admin initiative. Each is
  // safe to re-run — they no-op when the role / row already exists.
  try {
    await ensureAdminRole(sql);
    console.log("Admin DB role matgary_admin ready.");
  } catch (err) {
    console.warn(
      "[migrate] Could not provision matgary_admin role (continuing):",
      err instanceof Error ? err.message : err,
    );
  }
  try {
    await seedBootstrapAdmin(sql);
    console.log(`Bootstrap admin ${BOOTSTRAP_EMAIL} ensured.`);
  } catch (err) {
    console.warn(
      "[migrate] Could not seed bootstrap admin (table missing?):",
      err instanceof Error ? err.message : err,
    );
  }
  try {
    await seedPlatformPlans(sql);
    console.log("Platform plans seeded.");
  } catch (err) {
    console.warn(
      "[migrate] Could not seed platform_plans (continuing):",
      err instanceof Error ? err.message : err,
    );
  }

  await sql.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
