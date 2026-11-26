import "dotenv/config";
import bcrypt from "bcryptjs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email || !password) {
    console.error("usage: tsx scripts/check-password.ts <email> <password>");
    process.exit(1);
  }

  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(client);

  const rows = await db.execute(
    sql`select email, password_hash, must_change_password from users where email = ${email}`,
  );
  const row = rows[0];

  if (!row) {
    console.log(`user not found: ${email}`);
  } else {
    console.log(`found user: ${email}`);
    console.log(`  must_change_password: ${row.must_change_password}`);
    const ok = await bcrypt.compare(password, row.password_hash as string);
    console.log(`  bcrypt.compare("${password}", stored_hash) = ${ok}`);
  }

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
