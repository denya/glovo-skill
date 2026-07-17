import os from "node:os";
import path from "node:path";
import { runLogin } from "../src/auth/login.mjs";

const sessionPath = process.env.GLOVO_SESSION_PATH || path.join(os.homedir(), ".glovo", "session.json");
const result = await runLogin(sessionPath);
console.log(JSON.stringify({ signed_in: true, has_customer: Boolean(result.customerId), has_location: result.hasLocation, days_left: result.daysLeft }, null, 2));
