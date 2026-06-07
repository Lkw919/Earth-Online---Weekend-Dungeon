import React from "react";

type Props = {
  question: string;
  // 兼容旧调用：以下 props 现已不在气泡内使用(输入统一走主输入框),保留为可选避免改动调用方类型。
  value?: string;
  onChange?: (value: string) => void;
  onSubmit?: () => void;
  loading?: boolean;
};

export function ClarifyView({ question }: Props) {
  return (
    <div className="mt-3 rounded-[16px] border border-[#E8E4FF] bg-white p-4">
      <p className="text-[13px] font-semibold text-[#5E5B8C] whitespace-pre-wrap">{question}</p>
      <p className="mt-2 text-[12px] text-[#9A8CF0] font-medium">
        👇 在下方输入框直接补充即可
      </p>
    </div>
  );
}
