export async function chooseSpace(page, name) {
  await page.getByRole("button", { name: "Switch space", exact: true }).click();
  await page
    .getByRole("menu", { name: "Switch space", exact: true })
    .getByRole("menuitem", { name, exact: true })
    .click();
}
export async function openPageFromSidebar(page, name) {
  await page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
}
export async function accountSettings(page) {
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Account & security", exact: true })
    .click();
}
export async function databaseAction(page, name) {
  await page
    .getByRole("button", { name: "Database options", exact: true })
    .click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
export async function showAttachments(page) {
  await page.locator("summary").filter({ hasText: "Attachments" }).click();
}
