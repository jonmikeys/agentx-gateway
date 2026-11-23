import { expect, type Page, test } from "@playwright/test";
import { makePng } from "../tests/support/media-files";
import { type MockMjpeg, startMockMjpeg } from "../tests/support/mock-mjpeg";

const username = process.env.E2E_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? "";
const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "";
const runId = Date.now().toString(36);
const imageName = `E2E image ${runId}`;
const longName = `E2E camera with an extremely long title that keeps going and going ${runId}`;

test.use({ httpCredentials: { username, password } });
test.describe.configure({ mode: "serial" });

let camera: MockMjpeg;

test.beforeAll(async () => {
  camera = await startMockMjpeg({ frameIntervalMs: 50 });
});
test.afterAll(async () => {
  await camera.close();
});

async function openPage(page: Page, href: string, heading: string) {
  await page.goto(href);
  await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

async function expectNoHorizontalScroll(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, "page scrolls horizontally").toBeLessThanOrEqual(innerWidth);
}

/** No visible descendant of the open dialog may extend past the dialog's own box. */
async function expectDialogContained(page: Page) {
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]').last();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-state", "open");
  const overflowing = await dialog.evaluate((root) => {
    const box = root.getBoundingClientRect();
    const found: string[] = [];
    for (const element of root.querySelectorAll("*")) {
      if (element.closest('[aria-hidden="true"]')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > box.right + 1 || rect.left < box.left - 1) {
        found.push(`${element.tagName.toLowerCase()} ${Math.round(rect.right - box.right)}`);
      }
    }
    return found.slice(0, 5);
  });
  expect(overflowing, "elements overflow the dialog").toEqual([]);
  await expectNoHorizontalScroll(page);
}

test("upload an image, see its card, edit tags and disable it", async ({ page, request }) => {
  await openPage(page, "/media", "Media");
  const opener = page.getByRole("button", { name: "Upload media" }).first();
  await opener.click();
  await expectDialogContained(page);
  await page.getByTestId("media-file-input").setInputFiles({
    name: `${imageName}.png`,
    mimeType: "image/png",
    buffer: makePng(64, 48, [30, 120, 200]),
  });
  await page.getByLabel("Tags for these files").fill("e2e");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Upload 1 file" }).click();
  await expect(page.getByText("Uploaded 1 file")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const card = page.getByTestId("media-card").filter({ hasText: imageName });
  await expect(card).toBeVisible();
  await expect(card).toContainText("64x48");
  await expect(card).toContainText("e2e");
  // The thumbnail really loaded through the admin content route.
  await expect
    .poll(() => card.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(64);

  const edit = card.getByRole("button", { name: `Edit ${imageName}` });
  await edit.click();
  await expectDialogContained(page);
  await page.getByLabel("Description").fill("A blue rectangle for tests");
  await page.getByLabel("Tags").fill("second");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(card).toContainText("second");

  await card.getByRole("switch", { name: `Enable ${imageName}` }).click();
  await expect(card.getByText("Disabled").first()).toBeVisible();

  // Kind filter hides it; clearing brings it back.
  await page.getByRole("combobox", { name: "Filter by kind" }).click();
  await page.getByRole("option", { name: "Videos" }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(card).toBeVisible();

  // Clean up through the API so reruns stay tidy.
  const list = await (await request.get("/api/admin/media")).json();
  for (const item of list.data.filter((entry: { name: string }) => entry.name === imageName)) {
    await request.delete(`/api/admin/media/${item.id}`);
  }
});

test("rejects a non-media file in the upload dialog", async ({ page }) => {
  await openPage(page, "/media", "Media");
  await page.getByRole("button", { name: "Upload media" }).first().click();
  await page.getByTestId("media-file-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });
  await expect(page.getByRole("alert")).toContainText("Not a PNG");
  await expect(page.getByRole("button", { name: /^Upload$/ })).toBeDisabled();
});

test("create an mjpeg camera, test it and preview it", async ({ page, request }) => {
  await openPage(page, "/cameras", "Cameras");
  const opener = page.getByRole("button", { name: "New camera" });
  await opener.click();
  await expectDialogContained(page);
  await page.getByLabel("Name", { exact: true }).fill(longName);
  await page.getByLabel("Stream URL").fill(camera.streamUrl);
  await page.getByRole("button", { name: "Create camera" }).click();

  const row = page.getByRole("row").filter({ hasText: longName });
  await expect(row).toBeVisible();
  await expect(row).toContainText("mjpeg_url");

  await row.getByRole("button", { name: /^Test / }).click();
  await expect(page.getByRole("heading", { name: "Camera test passed" })).toBeVisible();
  await expectDialogContained(page);
  await page.keyboard.press("Escape");

  const preview = row.getByRole("button", { name: /^Preview / });
  await preview.click();
  const image = page.getByRole("img", { name: /Live preview/ });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expectDialogContained(page);
  await page.keyboard.press("Escape");

  const list = await (await request.get("/api/admin/cameras")).json();
  for (const item of list.data.filter((entry: { name: string }) => entry.name === longName)) {
    await request.delete(`/api/admin/cameras/${item.id}`);
  }
});

test("look-at cameras explain that preview is unavailable", async ({ page, request }) => {
  const name = `E2E look-at ${runId}`;
  const created = await request.post("/api/admin/cameras", {
    data: { type: "lookat_sidecar", name },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  await openPage(page, "/cameras", "Cameras");
  await page.getByRole("button", { name: `Preview ${name}` }).click();
  await expect(page.getByText("Preview is not available for lookat_sidecar")).toBeVisible();
  await page.keyboard.press("Escape");
  await request.delete(`/api/admin/cameras/${id}`);
});

for (const width of [1440, 390]) {
  test(`media and camera pages do not scroll horizontally at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const name = `E2E layout ${"very long name ".repeat(6)}${runId}`;
    const media = await request.post("/api/admin/media", {
      data: { name, external_url: `${camera.url}/none`, tags: ["layout"] },
    });
    // The external check fails for a non-media URL; the layout run still covers empty states.
    expect([201, 400, 415]).toContain(media.status());
    const created = await request.post("/api/admin/cameras", {
      data: { type: "mjpeg_url", name, url: `${camera.url}/${"p".repeat(120)}` },
    });
    expect(created.status()).toBe(201);
    for (const [href, heading] of [
      ["/media", "Media"],
      ["/cameras", "Cameras"],
    ]) {
      await openPage(page, href, heading);
      await expectNoHorizontalScroll(page);
      const unnamed = (await page.locator("body").ariaSnapshot())
        .split("\n")
        .filter((line) => /^\s*- (button|link)(\s+\[[^\]]*\])*:?\s*$/.test(line));
      expect(unnamed, "buttons or links without an accessible name").toEqual([]);
    }
    await page.getByRole("button", { name: `Edit ${name}` }).click();
    await expectDialogContained(page);
    await page.keyboard.press("Escape");
    const { id } = await created.json();
    await request.delete(`/api/admin/cameras/${id}`);
  });
}
