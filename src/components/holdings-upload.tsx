'use client';

import React, { useCallback, useRef, useState } from 'react';
import { Upload, ImagePlus, FileImage } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface HoldingsUploadProps {
  hasHoldings: boolean;
  snapshotDate: string | null;
  onImageUpload: (file: File) => void;
  onManualInput: () => void;
  isUploading: boolean;
}

export function HoldingsUpload({
  hasHoldings,
  snapshotDate,
  onImageUpload,
  onManualInput,
  isUploading,
}: HoldingsUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFileSelect = useCallback(
    (file: File) => {
      if (file && file.type.startsWith('image/')) {
        onImageUpload(file);
      }
    },
    [onImageUpload]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) {
        handleFileSelect(file);
      }
    },
    [handleFileSelect]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleFileSelect(file);
      }
      // Reset input so the same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [handleFileSelect]
  );

  if (hasHoldings) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex items-center justify-between pt-6 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
              <FileImage className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">
                持仓数据已录入
              </p>
              <p className="text-xs text-muted-foreground">
                {snapshotDate
                  ? `上次更新: ${new Date(snapshotDate).toLocaleDateString('zh-CN')}`
                  : '暂无数据'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
            >
              {isUploading ? '识别中...' : '更新本周持仓'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onManualInput}
              className="text-muted-foreground"
            >
              手动录入
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleInputChange}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className={`border-2 transition-colors cursor-pointer ${
        isDragging
          ? 'border-emerald-400 bg-emerald-50/50'
          : 'border-dashed border-muted-foreground/25 hover:border-muted-foreground/50'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => fileInputRef.current?.click()}
    >
      <CardContent className="flex flex-col items-center justify-center py-12 gap-4">
        <div
          className={`flex h-16 w-16 items-center justify-center rounded-2xl transition-colors ${
            isDragging
              ? 'bg-emerald-100 text-emerald-600'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          {isUploading ? (
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          ) : (
            <Upload className="h-8 w-8" />
          )}
        </div>
        <div className="text-center">
          <p className="text-base font-medium text-foreground">
            上传持仓截图
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            支持券商APP持仓截图，AI自动识别
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ImagePlus className="h-3.5 w-3.5" />
          <span>拖拽图片到此处或点击上传</span>
        </div>
        <Button
          variant="link"
          size="sm"
          className="text-muted-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onManualInput();
          }}
        >
          或手动录入
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleInputChange}
        />
      </CardContent>
    </Card>
  );
}
