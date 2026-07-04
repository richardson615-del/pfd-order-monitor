// Quick manual test: extracts the HTML body from a .eml order email and
// runs it through the parser so you can sanity-check output before wiring
// up Gmail. Usage:
//   npx tsx scripts/test-parser.ts path/to/order_body.html
import { readFileSync } from "fs";
import { parseOrderEmail, parseDueTimeToDate, moneyToNumber } from "../lib/parser";

const path = process.argv[2] || "/tmp/order_body.html";
const html = readFileSync(path, "utf-8");
const parsed = parseOrderEmail(html);

console.log(JSON.stringify(parsed, null, 2));
console.log("Due date parsed:", parseDueTimeToDate(parsed.dueTime));
console.log("Customer total as number:", moneyToNumber(parsed.customerTotal));
