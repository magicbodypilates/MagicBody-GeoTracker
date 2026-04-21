import { NextRequest, NextResponse } from "next/server";
import { parseBingCsv } from "@/lib/server/bing-csv";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    let csvText = "";
    let fileName = "uploaded.csv";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: "multipart/form-data에 'file' 필드가 없습니다." },
          { status: 400 }
        );
      }
      if (file.size > MAX_BYTES) {
        return NextResponse.json(
          { error: `파일이 너무 큽니다 (>${MAX_BYTES} bytes).` },
          { status: 400 }
        );
      }
      fileName = file.name || fileName;
      csvText = await file.text();
    } else if (
      contentType.includes("text/csv") ||
      contentType.includes("text/plain")
    ) {
      csvText = await req.text();
      const hinted = req.headers.get("x-file-name");
      if (hinted) fileName = hinted;
    } else {
      return NextResponse.json(
        {
          error:
            "Content-Type은 multipart/form-data 또는 text/csv 여야 합니다.",
        },
        { status: 400 }
      );
    }

    if (!csvText.trim()) {
      return NextResponse.json(
        { error: "빈 CSV 입니다." },
        { status: 400 }
      );
    }

    const result = parseBingCsv(csvText, fileName);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
