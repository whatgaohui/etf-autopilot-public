import ZAI from 'z-ai-web-dev-sdk';
import { NextRequest, NextResponse } from 'next/server';

// POST /api/ocr - Upload image and get OCR result
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const imageFile = formData.get('image') as File;

    if (!imageFile) {
      return NextResponse.json(
        { error: 'No image provided' },
        { status: 400 }
      );
    }

    // Convert to base64
    const bytes = await imageFile.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const base64Image = buffer.toString('base64');
    const mimeType = imageFile.type;
    const imageUrl = `data:${mimeType};base64,${base64Image}`;

    // Call VLM
    const zai = await ZAI.create();
    const response = await zai.chat.completions.createVision({
      model: 'default',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `请识别这张券商持仓截图中的所有ETF基金信息。以JSON数组格式输出，每个元素包含：
- name: 基金名称（如"中证A500ETF"）
- code: 基金代码（如"159338"）
- shares: 持仓份额（数字）
- costPrice: 成本价（数字）
- marketValue: 市值（数字）
- profitLoss: 盈亏金额（数字，可为负）
- availableShares: 可用份额（数字，如无法识别则设为null）

只输出JSON数组，不要其他文字。如果某个字段无法识别，设为null。`,
            },
            {
              type: 'image_url',
              image_url: { url: imageUrl },
            },
          ],
        },
      ],
      thinking: { type: 'disabled' },
    });

    const content = response.choices[0]?.message?.content || '[]';

    // Try to parse JSON from the response
    let holdings: Array<Record<string, unknown>>;
    try {
      // Try to extract JSON from markdown code blocks if present
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      holdings = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    } catch {
      holdings = [];
    }

    return NextResponse.json({ holdings });
  } catch (error) {
    console.error('OCR error:', error);
    return NextResponse.json(
      { error: 'OCR recognition failed' },
      { status: 500 }
    );
  }
}
