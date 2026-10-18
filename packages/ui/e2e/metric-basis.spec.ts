import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { open, state } from "./util";

const cases = [
 { id: "legacy", hits:30, dismissed:14, precision:null, noisy:false, basis:"legacy_mixed", assessment_known:false },
 { id: "clean", hits:20, dismissed:14, precision:0.3, noisy:true, basis:"actionable_v1", assessment_known:true },
 { id: "zero", hits:0, dismissed:0, precision:null, noisy:false, basis:"actionable_v1", assessment_known:false },
 { id: "older-server", hits:30, dismissed:14, precision:0.53333, noisy:true },
];
for (const value of cases) test(`check surfaces show ${value.id} metric truthfully`, async ({page}, info) => {
 await page.route("**/api/checks", async route => {
  if (route.request().method() !== "GET") return route.continue();
  const response=await route.fetch();const data=await response.json();
  const c={...data.checks[0],id:"basis-"+value.id,title:"Metric "+value.id,kind:"rule",source:"user",precision:value};
  await route.fulfill({json:{...data,checks:[c]}});
 });
 await open(page,"checks");
 const row=page.getByRole("row").filter({hasText:"basis-"+value.id});
 if(value.id==="clean") {await expect(row).toContainText("30% kept");await expect(row).toContainText("Noisy");}
 else {await expect(row).toContainText("Rate / Noisy unknown");await expect(row).not.toContainText("53% kept");}
 await page.getByText("Metric "+value.id,{exact:true}).click();
 const sheet=page.getByRole("dialog");
 await expect(sheet).toContainText(value.id==="clean" ? "30% kept" : "Kept rate unavailable");
 if(value.id!=="clean") await expect(sheet).toContainText("Noisy assessment unknown");
 if(value.id==="legacy" || value.id==="older-server") await expect(sheet).toContainText("30 historical records");
 const dir=process.env.ISSUE281_SCREENSHOTS;
 if(dir && info.repeatEachIndex===0 && ["legacy","clean"].includes(value.id)) {
  fs.mkdirSync(dir,{recursive:true});
  for(const width of [1440,390]) for(const theme of ["light","dark"] as const) {
   await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
   await page.evaluate(t=>document.documentElement.classList.toggle("dark",t==="dark"),theme);
   await expect(sheet.getByText("Metric "+value.id,{exact:true})).toBeVisible();
   await page.screenshot({path:path.join(dir,`${value.id}-${theme}-${width}.png`),animations:"disabled"});
  }
 }
});
test("run-page finding quality is unknown when an older server supplies no basis",async({page})=>{
 await page.route("**/api/runs/"+state().loopRun,async route=>{
  const response=await route.fetch();const data=await response.json();
  await route.fulfill({json:{...data,findings:data.findings.map((f:object)=>({...f,precision:{hits:30,dismissed:14,precision:0.53333,noisy:false}}))}});
 });
 await open(page,"runs/"+state().loopRun);
 const toggle=page.getByRole("button",{name:/repeated|same tool/i}).first();
 if(await toggle.getAttribute("aria-expanded")!=="true") await toggle.click();
 await expect(page.getByText("Kept rate unavailable · Noisy assessment unknown").first()).toBeVisible();
 await expect(page.getByText(/53% of past findings kept/)).toHaveCount(0);
});
