import { NextRequest, NextResponse } from 'next/server';

// LINE ID認証用のシンプルなAPIルート
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const token = searchParams.get('token');
    const lineId = searchParams.get('lineId');

    // トークンとLINE IDの検証
    if (!token || !lineId) {
      return NextResponse.json(
        { error: '無効なパラメータです' },
        { status: 400 }
      );
    }

    // シンプルな検証（LINE IDのみの認証）
    // 実際の運用では、より厳密な検証が必要です
    const isValid = token && lineId && token.length > 0;

    return NextResponse.json({
      success: isValid,
      lineId: isValid ? lineId : null,
      message: isValid ? '認証成功' : '認証失敗'
    });
  } catch (error) {
    console.error('Link API error:', error);
    return NextResponse.json(
      { error: 'サーバーエラーが発生しました' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, lineId } = body;

    // トークンとLINE IDの検証
    if (!token || !lineId) {
      return NextResponse.json(
        { error: '無効なパラメータです' },
        { status: 400 }
      );
    }

    // シンプルな検証と連携処理
    // 実際の運用では、データベースへの保存などが必要
    const isLinked = true;

    return NextResponse.json({
      success: isLinked,
      lineId: isLinked ? lineId : null,
      message: isLinked ? '連携が完了しました' : '連携に失敗しました'
    });
  } catch (error) {
    console.error('Link API error:', error);
    return NextResponse.json(
      { error: 'サーバーエラーが発生しました' },
      { status: 500 }
    );
  }
}
