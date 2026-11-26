import "dotenv/config";
import bcrypt from "bcryptjs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];
  if (!email || !password) {
    console.error("usage: tsx scripts/reset-employee.ts <email> <password>");
    process.exit(1);
  }

  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(client);
  const hash = await bcrypt.hash(password, 12);

  const result = await db.execute(
    sql`update users set password_hash = ${hash}, must_change_password = false where email = ${email} returning email`,
  );

  if (result.length === 0) {
    console.log(`no user with email ${email}`);
  } else {
    console.log(
      `✅ reset password for ${email} to "${password}" (must_change_password cleared)`,
    );
  }

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
