import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'line-kakeibo-web',
    environment: process.env.NODE_ENV || 'development',
    firebase: {
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'not-configured'
    }
  });
}
