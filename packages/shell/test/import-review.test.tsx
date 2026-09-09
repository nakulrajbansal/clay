/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ImportReview, type ReviewedImportFile } from "../src/app/ImportReview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const parsed: ReviewedImportFile = {
  table: "customer_orders",
  columns: [
    { name: "customer", type: "text" },
    { name: "total", type: "number" },
    { name: "ordered_at", type: "date" },
  ],
  rows: [{ customer: "Ada", total: 12, ordered_at: "2026-09-01" }],
  review: {
    sourceRows: 12,
    acceptedRows: 9,
    skippedRows: 2,
    truncatedRows: 1,
    sourceColumns: 22,
    acceptedColumns: 20,
    truncatedColumns: 2,
  },
};

async function mount(props: Partial<React.ComponentProps<typeof ImportReview>> = {}): Promise<{
  unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  const root = createRoot(container);
  await act(async () => root.render(<ImportReview
    fileName="orders.csv"
    parsed={parsed}
    busy={false}
    onCancel={() => undefined}
    onConfirm={() => undefined}
    {...props}
  />));
  return { unmount: async () => { await act(async () => root.unmount()); } };
}

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(candidate => candidate.textContent?.includes(name));
  if (!found) throw new Error(`missing ${name}: ${document.body.innerHTML}`);
  return found;
};

function reviewRows(): Record<string, string> {
  const result: Record<string, string> = {};
  const terms = [...document.querySelectorAll("dt")];
  for (const term of terms) {
    const value = term.nextElementSibling;
    result[term.textContent ?? ""] = value?.textContent ?? "";
  }
  return result;
}

describe("ImportReview", () => {
  it("shows the exact reviewed table, row disposition, and schema truncation before commit", async () => {
    const { unmount } = await mount();

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("orders.csv");
    expect(reviewRows()).toEqual({
      "Proposed table": "customer_orders",
      "Rows in file": "12",
      "Rows accepted": "9",
      "Rows skipped": "2",
      "Rows truncated": "1",
      "Fields in file": "22",
      "Fields accepted": "20",
      "Fields truncated": "2",
    });
    expect(document.querySelector('[aria-labelledby="import-schema-title"]')?.textContent)
      .toContain("customer - text");
    expect(document.querySelector('[aria-labelledby="import-schema-title"]')?.textContent)
      .toContain("total - number");
    expect(document.querySelector('[role="status"]')?.textContent)
      .toContain("Only this reviewed subset will be imported");
    expect(button("Import accepted rows").textContent).toContain("9");
    await unmount();
  });

  it("makes the bounded proposed-field scroller keyboard reachable and named", async () => {
    const { unmount } = await mount();
    const fields = document.querySelector<HTMLUListElement>("#import-schema-title + ul");

    expect(fields?.tabIndex).toBe(0);
    expect(fields?.getAttribute("aria-labelledby")).toBe("import-schema-title");
    await unmount();
  });

  it("keeps the reviewed subset available while a safe retry error is announced", async () => {
    const mounted = await mount({
      error: "The worker may already have finished it. Retry without duplicates.",
    });
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain("Retry without duplicates");
    expect(button("Import accepted rows").disabled).toBe(false);
    await mounted.unmount();
  });

  it("requires an explicit enabled confirmation and preserves cancel while busy", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    let mounted = await mount({ onConfirm, onCancel });
    await act(async () => button("Import accepted rows").click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => button("Go back").click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    await mounted.unmount();

    mounted = await mount({ busy: true, onConfirm, onCancel });
    expect(button("Importing").disabled).toBe(true);
    expect(button("Go back").disabled).toBe(true);
    await mounted.unmount();
  });
});
