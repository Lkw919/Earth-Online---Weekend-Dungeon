import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ChevronLeft, Globe, Sparkles, Sword,
  ArrowRight, MapPin, Flag, IceCreamCone,
  Check, QrCode, Send, ChevronRight,
  Castle, Share
} from 'lucide-react';
import { toast, Toaster } from 'sonner';
import { startPlan, clarifyPlan, executePlan, resolveConflict, locateByCoords, isSseEvent, type SseEnvelope } from './lib/api';
import {
  adaptExecutionActions,
  adaptPlanState,
  buildConflictSolutions,
  inferVoucherCode,
  taskStatusLabel,
  type UiExecutionTask,
  type UiPlace,
  type UiPlaceDetail,
  type UiSegment,
} from './lib/adapter';

function statusColorByStatus(status: string): string {
  if (status === 'success') return '#27AE60';
  if (status === 'failed') return '#E0556B';
  return '#6B63F6';
}

// 根据用户选择的「目的 + 人数」生成副本类型文案(用于通关页 / 浮层)。
function dungeonProfile(purpose: string | null, people: string | null): { type: string; tag: string } {
  const solo = people === '1人' || purpose === '独自放空';
  switch (purpose) {
    case '约会':
      return { type: '周末甜蜜约会副本', tag: '约会副本' };
    case '带娃玩':
      return { type: '周末亲子遛娃副本', tag: '亲子副本' };
    case '朋友聚会':
      return { type: '周末好友聚会副本', tag: '聚会副本' };
    case '陪父母':
      return { type: '周末陪伴家人副本', tag: '陪伴副本' };
    case '带宠物':
      return { type: '周末萌宠出街副本', tag: '萌宠副本' };
    case '自习办公':
      return { type: solo ? '一人专注充电副本' : '组队专注充电副本', tag: '专注副本' };
    case '独自放空':
      return { type: '一人solo周末副本', tag: 'solo副本' };
    default:
      return { type: solo ? '一人solo周末副本' : '周末探索副本', tag: '周末副本' };
  }
}

// 根据用户选择的「目的 + 氛围」生成一个简短的副本名(用于通关页标题/封面卡)。
function dungeonRouteName(purpose: string | null, mood: string | null): string {
  const purposeName: Record<string, string> = {
    约会: '甜蜜约会副本',
    带娃玩: '亲子遛娃副本',
    朋友聚会: '好友聚会副本',
    独自放空: '一人放空副本',
    陪父母: '温馨陪伴副本',
    带宠物: '萌宠合作副本',
    自习办公: '专注充电副本',
  };
  // 没有明确目的时,用氛围兜底命名
  const moodName: Record<string, string> = {
    活力闯关: '活力闯关副本',
    慢慢逛逛: '休闲trip副本',
    吃好喝好: '美食巡游副本',
    拍照打卡: '打卡漫游副本',
  };
  if (purpose && purposeName[purpose]) return purposeName[purpose];
  if (mood) {
    const key = Object.keys(moodName).find((k) => mood.includes(k) || k.includes(mood));
    if (key) return moodName[key];
  }
  return '周末探索副本';
}

// 把 "1.2km" / "800米" / "—" 解析成米
function parseDistanceMeters(text: string): number {
  if (!text) return 0;
  const m = text.match(/([\d.]+)\s*(km|公里|米|m)?/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  if (!Number.isFinite(val)) return 0;
  const unit = (m[2] || '').toLowerCase();
  return unit === 'km' || unit === '公里' ? val * 1000 : val;
}

// 从 "HH:MM-HH:MM" 取起止;计算整段行程时长(小时)
function computeDurationHours(slots: string[]): number {
  const times: number[] = [];
  for (const s of slots) {
    const matches = s.match(/(\d{1,2}):(\d{2})/g) || [];
    for (const t of matches) {
      const [h, mi] = t.split(':').map(Number);
      times.push(h * 60 + mi);
    }
  }
  if (times.length < 2) return 0;
  const diff = Math.max(...times) - Math.min(...times);
  return diff > 0 ? diff / 60 : 0;
}
import { ClarifyView } from './components/ClarifyView';
import { RouteMap } from './components/RouteMap';
import { PlanSetupView } from './components/PlanSetupView';

import AGENT_AVATAR from '../imports/agent-avatar.png';
import BG_IMAGE from '../imports/bg.png';
import EARTH_PNG from '../imports/earth.png';
import PLACE_IMG_FALLBACK from '../imports/IMG_0497.PNG';
// Figma 新增界面(核销成功浮层 / 副本通关结果页)所需 PNG
import SUCCESS_IP from '../imports/0145EA9B-E52B-4914-BE91-71369C022747.PNG';
import PLACE_IMG_1 from '../imports/B55099AF-1497-4ED8-BB47-0992EB7FF1B4.PNG';
import MISSION_TITLE_STAR_PNG from '../imports/_____-1_6.png';

const QUESTIONS = [
  {
    id: 'purpose',
    title: '① 今天主要目的是什么？',
    options: ['带娃玩', '朋友聚会', '约会', '独自放空', '陪父母', '带宠物', '自习办公']
  },
  {
    id: 'people',
    title: '② 几个人出发？',
    options: ['1人', '2人', '3-4人', '5人+']
  },
  {
    id: 'vibe',
    title: '③ 想要什么氛围？',
    options: ['活力闯关', '慢慢逛逛', '吃好喝好', '拍照打卡']
  }
];

interface GeneratePlanPayload {
  purpose: string | null;
  people: string | null;
  mood: string | null;
  userText: string;
  source: 'text' | 'chips';
}

function IntroScreen({ onStart }: { onStart: () => void }) {
  const [showAvatar, setShowAvatar] = useState(false);
  const [showText, setShowText] = useState(false);
  const [showButton, setShowButton] = useState(false);
  const [displayText, setDisplayText] = useState("");
  const fullText = "一句话定制你的周末副本";

  useEffect(() => {
    const t1 = setTimeout(() => setShowAvatar(true), 600);
    const t2 = setTimeout(() => setShowText(true), 1100);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  useEffect(() => {
    if (!showText) return;
    let i = 0;
    const interval = setInterval(() => {
      setDisplayText(fullText.slice(0, i + 1));
      i++;
      if (i >= fullText.length) {
        clearInterval(interval);
        setTimeout(() => setShowButton(true), 200);
      }
    }, 65);
    return () => clearInterval(interval);
  }, [showText]);

  return (
    <div className="flex flex-col items-center min-h-[100dvh] w-full relative z-50" style={{ paddingTop: 'max(143px, 17vh)' }}>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
        className="flex flex-col items-center text-center"
      >
        <div className="flex items-center gap-[10px] mb-[6px]">
          <Globe className="w-10 h-10 text-[#6B63F6] stroke-[2.5] shrink-0" />
          <h1 className="leading-none flex items-baseline gap-[3px]">
            <span
              style={{
                fontWeight: 900,
                fontSize: '36px',
                background: 'linear-gradient(135deg, #7B6EF6 0%, #5B8AF0 100%)',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
              }}
            >地球</span>
            <span
              style={{
                fontFamily: '"Press Start 2P", monospace',
                fontSize: '18px',
                background: 'linear-gradient(135deg, #7B6EF6 0%, #5B8AF0 100%)',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
                letterSpacing: '0.5px',
              }}
            >Online</span>
          </h1>
        </div>
        <div className="flex items-center" style={{ marginLeft: '50px' }}>
          <span
            className="text-[#8B82F0] whitespace-nowrap"
            style={{ fontSize: '14px', fontWeight: 600, letterSpacing: '1.4px', opacity: 0.88 }}
          >
            周末副本 · 组队中...
          </span>
          <span className="inline-block w-[3px] h-[16px] rounded-[2px] bg-[#7B6EF6] ml-[4px] animate-[blink_1s_step-end_infinite]" />
        </div>
      </motion.div>

      <AnimatePresence>
        {showAvatar && (
          <motion.div
            initial={{ opacity: 0, y: 22, scale: 0.88 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
            className="relative flex items-center justify-center"
            style={{ width: '360px', height: '360px', marginTop: '16px', flexShrink: 0, overflow: 'visible' }}
          >
            <div
              className="absolute pointer-events-none"
              style={{
                width: '480px',
                height: '300px',
                borderRadius: '999px',
                bottom: '-28px',
                left: '50%',
                transform: 'translateX(-50%)',
                background: 'radial-gradient(ellipse at 50% 60%, rgba(167,148,255,0.30) 0%, rgba(123,110,246,0.18) 30%, rgba(91,138,240,0.10) 55%, transparent 75%)',
                filter: 'blur(36px)',
                animation: 'auroraBreath 3s ease-in-out infinite',
                zIndex: 0,
              }}
            />
            <div
              className="absolute pointer-events-none"
              style={{
                width: '300px',
                height: '80px',
                borderRadius: '999px',
                bottom: '20px',
                left: '50%',
                transform: 'translateX(-50%)',
                background: 'radial-gradient(ellipse at center, rgba(123,110,246,0.35) 0%, rgba(91,138,240,0.20) 45%, transparent 70%)',
                filter: 'blur(24px)',
                animation: 'glowBreath 2.6s ease-in-out infinite',
                zIndex: 1,
              }}
            />
            <div
              className="absolute pointer-events-none"
              style={{
                width: '340px',
                height: '76px',
                border: '1.5px solid rgba(167,148,255,0.24)',
                borderRadius: '999px',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%) rotateX(72deg)',
                boxShadow: '0 0 16px rgba(123,110,246,0.14)',
                animation: 'orbitPulse 5s ease-in-out infinite',
                zIndex: 2,
              }}
            />
            <div
              className="absolute pointer-events-none"
              style={{
                width: '268px',
                height: '54px',
                border: '1px solid rgba(91,138,240,0.20)',
                borderRadius: '999px',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%) rotateX(72deg) rotateZ(38deg)',
                animation: 'orbitPulse 7s ease-in-out infinite reverse',
                zIndex: 2,
              }}
            />
            {[
              { w: 3, h: 3, top: '18%', left: '10%', delay: '0s',   dur: '2.2s' },
              { w: 4, h: 4, top: '12%', left: '76%', delay: '0.6s', dur: '3s'   },
              { w: 3, h: 3, top: '68%', left: '90%', delay: '1.1s', dur: '2.6s' },
              { w: 3, h: 3, top: '74%', left: '6%',  delay: '0.3s', dur: '2.8s' },
              { w: 4, h: 4, top: '38%', left: '93%', delay: '1.5s', dur: '3.4s' },
              { w: 3, h: 3, top: '26%', left: '3%',  delay: '0.9s', dur: '2.4s' },
            ].map((s, i) => (
              <div
                key={i}
                className="absolute rounded-full bg-white pointer-events-none"
                style={{
                  width: s.w, height: s.h,
                  top: s.top, left: s.left,
                  opacity: 0.7,
                  animation: `starTwinkle ${s.dur} ease-in-out ${s.delay} infinite`,
                  zIndex: 3,
                }}
              />
            ))}
            <div
              className="absolute rounded-full pointer-events-none"
              style={{
                width: '310px',
                height: '310px',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                background: 'radial-gradient(circle, rgba(255,255,255,0.05) 0%, rgba(123,110,246,0.14) 40%, rgba(91,138,240,0.07) 65%, transparent 80%)',
                filter: 'blur(10px)',
                animation: 'bloomPulse 2.6s ease-in-out infinite',
                zIndex: 4,
              }}
            />
            <img
              src={EARTH_PNG}
              alt="发光地球"
              style={{
                position: 'relative',
                zIndex: 5,
                width: '500px',
                height: '500px',
                objectFit: 'contain',
                animation: 'earthFloat 4s ease-in-out infinite',
                filter: 'drop-shadow(0 0 32px rgba(123,110,246,0.45)) drop-shadow(0 0 12px rgba(255,255,255,0.20))',
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-col items-center w-full px-6" style={{ marginTop: '-24px', minHeight: '48px' }}>
        {showText && (
          <p className="text-[20px] font-bold leading-[32.5px] whitespace-pre-wrap text-center tracking-[-0.45px]" style={{ color: '#8B82F0' }}>
            {displayText}
            {displayText.length < fullText.length && (
              <span className="inline-block w-[2px] h-[18px] bg-[#6B63F6] ml-1 animate-pulse" />
            )}
          </p>
        )}
      </div>

      <AnimatePresence>
        {showButton && (
          <motion.button
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            onClick={onStart}
            className="bg-gradient-to-r from-[#7B6EF6] to-[#5B8AF0] text-white font-black rounded-[20px] hover:scale-[1.03] active:scale-95 transition-transform"
            style={{
              marginTop: '20px',
              width: '236px',
              height: '61px',
              fontSize: '17px',
              letterSpacing: '-0.43px',
              boxShadow: '0 10px 25px rgba(107,99,246,0.35)',
            }}
          >
            开始副本
          </motion.button>
        )}
      </AnimatePresence>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes blink {
          from, to { opacity: 1; }
          50% { opacity: 0; }
        }
        @keyframes earthFloat {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-9px); }
        }
        @keyframes glowBreath {
          0%, 100% { opacity: 0.55; transform: translateX(-50%) scale(0.97); }
          50% { opacity: 1; transform: translateX(-50%) scale(1.06); }
        }
        @keyframes auroraBreath {
          0%, 100% { opacity: 0.7; transform: translateX(-50%) scale(1); }
          40% { opacity: 1; transform: translateX(-50%) scale(1.06); }
          70% { opacity: 0.75; transform: translateX(-50%) scale(1.02); }
        }
        @keyframes orbitPulse {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 1; }
        }
        @keyframes bloomPulse {
          0%, 100% { opacity: 0.5; transform: translate(-50%, -50%) scale(0.96); }
          50% { opacity: 1; transform: translate(-50%, -50%) scale(1.07); }
        }
        @keyframes starTwinkle {
          0%, 100% { opacity: 0.2; transform: scale(0.8); }
          50% { opacity: 0.9; transform: scale(1.3); }
        }
      `}} />
    </div>
  );
}


function PlaceCard({ place, index, onClick }: { place: UiPlace & { placeImg: string }; index: number; onClick?: () => void }) {
  return (
    <div
      className="bg-white rounded-[16px] border border-[#E8E4FF] p-3 flex gap-3 items-center cursor-pointer hover:shadow-[0_6px_18px_rgba(123,110,246,0.10)] transition-shadow active:scale-[0.99]"
      onClick={onClick}
    >
      <div
        className="shrink-0 rounded-[12px] overflow-hidden"
        style={{ width: '92px', height: '78px' }}
      >
        <img
          src={place.placeImg}
          alt={place.place_title}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="leading-tight mb-1" style={{ fontSize: '14px', fontWeight: 700, color: '#5E5B8C' }}>
          {index + 1}. {place.time_slot}｜{place.place_title}
        </h4>
        <p className="mb-1.5 line-clamp-2" style={{ fontSize: '11.5px', lineHeight: '16px', color: '#5E627A' }}>
          {place.place_description}
        </p>
        <div className="flex gap-1.5 flex-wrap">
          {place.place_tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-[#F4F1FF]"
              style={{ fontSize: '10.5px', color: '#6B63F6', padding: '2px 8px', fontWeight: 600 }}
            >
              {tag}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ResultBody({
  purpose,
  people,
  mood,
  places,
  segments,
  routeTitle,
  locationLabel,
  dataSource,
  emptyReason,
  onReset,
  onPlaceClick,
  onOrder,
  orderLoading,
}: {
  purpose: string | null;
  people: string | null;
  mood: string | null;
  places: Array<UiPlace & { placeImg: string; iconComponent: any }>;
  segments: UiSegment[];
  routeTitle: string;
  locationLabel: string;
  dataSource: string;
  emptyReason: string;
  onReset: () => void;
  onPlaceClick: (index: number) => void;
  onOrder: () => void;
  orderLoading: boolean;
}) {
  const selectedTags = [purpose, people, mood].filter(Boolean) as string[];
  const [revealStep, setRevealStep] = useState(0);
  useEffect(() => {
    const timeouts: number[] = [];
    const schedule = [0, 300, 600, 900, 1200, 1500, 1800];
    schedule.forEach((delay, i) => {
      timeouts.push(window.setTimeout(() => setRevealStep(i + 1), delay));
    });
    return () => timeouts.forEach(t => clearTimeout(t));
  }, []);

  const fade = (step: number) => ({
    initial: { opacity: 0, y: 14 },
    animate: revealStep > step ? { opacity: 1, y: 0 } : { opacity: 0, y: 14 },
    transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  });

  return (
    <>
      <motion.div
        {...fade(0)}
        className="bg-white rounded-[22px] p-5 shadow-[0_4px_20px_rgba(123,110,246,0.06)] border border-[#E8E4FF] mb-5 mt-2 relative overflow-hidden"
      >
        <div className="absolute top-0 right-0 w-28 h-24 opacity-[0.10] pointer-events-none"
          style={{
            background: 'linear-gradient(135deg, #7B6EF6 0%, #5B8AF0 100%)',
            WebkitMaskImage: 'radial-gradient(ellipse at top right, black 30%, transparent 70%)',
            maskImage: 'radial-gradient(ellipse at top right, black 30%, transparent 70%)',
          }}
        />
        <h2 className="mb-1.5 relative z-10" style={{ fontSize: '20px', fontWeight: 800, color: '#5E5B8C' }}>
          已为你生成专属路线！
        </h2>
        <p className="mb-4 relative z-10" style={{ fontSize: '13px', color: '#5E627A', lineHeight: '20px' }}>
          根据你的选择，我们为你匹配了今天的周末副本。
          {locationLabel && (
            <span className="block mt-1" style={{ fontSize: '12px', color: '#6B63F6' }}>
              规划区域：{locationLabel}
              {dataSource === 'amap' ? ' · 高德 POI' : dataSource === 'mock' ? ' · 演示数据' : ''}
            </span>
          )}
        </p>
        <div className="flex flex-wrap gap-2 relative z-10">
          {selectedTags.map((tag, i) => (
            <span
              key={i}
              className="rounded-full bg-[#F1EEFF]"
              style={{ padding: '6px 14px', fontSize: '12.5px', color: '#6B63F6', fontWeight: 600 }}
            >
              {tag}
            </span>
          ))}
        </div>
      </motion.div>

      <motion.div
        {...fade(1)}
        className="bg-white rounded-[22px] p-5 shadow-[0_4px_20px_rgba(123,110,246,0.06)] border border-[#E8E4FF]"
      >
        <div className="flex items-center gap-2 mb-1">
          <Sword className="w-5 h-5 text-[#6B63F6]" />
          <h3 style={{ fontSize: '17px', fontWeight: 700, color: '#5E5B8C' }}>今日主线任务</h3>
        </div>
        <p className="mb-5" style={{ fontSize: '14px', fontWeight: 600, color: '#6B63F6' }}>
          {routeTitle || '【已生成专属路线】'}
        </p>

        {places.length === 0 ? (
          <div className="rounded-[14px] border border-dashed border-[#D8D3FF] bg-[#FBFAFF] p-4">
            <p style={{ fontSize: '13px', color: '#5E627A', lineHeight: '20px' }}>
              当前未生成可用路线，请重试或补充信息。
            </p>
            {emptyReason && (
              <p className="mt-1" style={{ fontSize: '12px', color: '#8A8FA8', lineHeight: '18px' }}>
                原因：{emptyReason}
              </p>
            )}
          </div>
        ) : (
        <div className="relative">
          {places.map((place, idx) => {
            const Icon = place.iconComponent;
            const isLast = idx === places.length - 1;
            const cardStep = 2 + idx;
            return (
              <motion.div
                key={place.place_id}
                {...fade(cardStep)}
                className="flex gap-3 items-stretch relative pb-5"
              >
                <div className="flex flex-col items-center shrink-0" style={{ width: '36px' }}>
                  <div
                    className="rounded-full flex items-center justify-center shrink-0"
                    style={{
                      width: '36px',
                      height: '36px',
                      background: '#F1EEFF',
                      color: '#6B63F6',
                      boxShadow: '0 2px 6px rgba(123,110,246,0.12)',
                    }}
                  >
                    <Icon className="w-[18px] h-[18px]" strokeWidth={2.2} />
                  </div>
                  {!isLast && (
                    <div className="flex-1 flex flex-col items-center justify-center py-1.5 min-h-[40px]">
                      <div className="flex-1" style={{ width: '0', borderLeft: '1px dashed #D8D3FF', minHeight: '14px' }} />
                      <div className="my-1 text-center whitespace-nowrap" style={{ fontSize: '11px', fontWeight: 600, color: '#6B63F6', lineHeight: '14px' }}>
                        <div>{segments[idx]?.distance ?? '--'}</div>
                        <div>· {segments[idx]?.duration ?? '--'}</div>
                      </div>
                      <div className="flex-1" style={{ width: '0', borderLeft: '1px dashed #D8D3FF', minHeight: '14px' }} />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <PlaceCard place={place} index={idx} onClick={() => onPlaceClick(idx)} />
                </div>
              </motion.div>
            );
          })}
        </div>
        )}
      </motion.div>

      <motion.div {...fade(6)} className="mt-6 flex gap-3 pb-2">
        <button
          onClick={onReset}
          className="flex-1 rounded-[16px] bg-gradient-to-r from-[#7B6EF6] to-[#5B8AF0] text-white shadow-[0_6px_16px_rgba(107,99,246,0.30)] hover:scale-[1.02] active:scale-[0.98] transition-transform"
          style={{ height: '52px', fontSize: '15px', fontWeight: 700 }}
        >
          重新生成
        </button>
        <button
          onClick={onOrder}
          disabled={orderLoading}
          className="flex-1 rounded-[16px] bg-gradient-to-r from-[#7B6EF6] to-[#5B8AF0] text-white shadow-[0_6px_16px_rgba(107,99,246,0.30)] active:scale-[0.98] transition-transform relative overflow-visible"
          style={{
            height: '52px',
            fontSize: '15px',
            fontWeight: 700,
            boxShadow: orderLoading
              ? '0 0 0 6px rgba(107,99,246,0.18), 0 0 24px rgba(107,99,246,0.45), 0 6px 16px rgba(107,99,246,0.30)'
              : '0 6px 16px rgba(107,99,246,0.30)',
            animation: orderLoading ? 'orderGlow 1.4s ease-in-out infinite' : undefined,
          }}
        >
          {orderLoading ? (
            <span className="inline-flex items-center justify-center gap-[6px]">
              {[0, 0.15, 0.3].map((d, i) => (
                <span
                  key={i}
                  className="inline-block rounded-full bg-white"
                  style={{
                    width: '7px',
                    height: '7px',
                    animation: `orderDot 1s ${d}s infinite ease-in-out`,
                  }}
                />
              ))}
            </span>
          ) : (
            '一键下单'
          )}
        </button>
        <style dangerouslySetInnerHTML={{ __html: `
          @keyframes orderDot {
            0%, 80%, 100% { opacity: 0.4; transform: translateY(0) scale(0.85); }
            40% { opacity: 1; transform: translateY(-2px) scale(1); }
          }
          @keyframes orderGlow {
            0%, 100% { box-shadow: 0 0 0 4px rgba(107,99,246,0.15), 0 0 20px rgba(107,99,246,0.35), 0 6px 16px rgba(107,99,246,0.30); }
            50% { box-shadow: 0 0 0 8px rgba(107,99,246,0.22), 0 0 28px rgba(107,99,246,0.50), 0 6px 16px rgba(107,99,246,0.30); }
          }
        `}} />
      </motion.div>
    </>
  );
}

const PROCESSING_TASKS = [
  '正在确认目的地开放状态与导航路线...',
  '正在查询附近餐厅排队情况...',
  '已为生成到点排号策略',
  '正在锁定活动场馆门票...',
  '正在设置排号提醒...',
  '执行计划已生成，准备进入托管模式',
];

function AgentProcessingPage({
  onBack,
  onConflict,
  onPrimary,
  phase = 'running',
  conflictReason = '',
  tasks = PROCESSING_TASKS,
}: {
  onBack: () => void;
  onConflict: () => void;
  onPrimary: () => void;
  phase?: 'running' | 'conflict' | 'ok';
  conflictReason?: string;
  tasks?: string[];
}) {
  const [visibleCount, setVisibleCount] = useState(0);
  const isRunning = phase === 'running';
  const isConflict = phase === 'conflict';

  useEffect(() => {
    if (!isRunning) {
      setVisibleCount(tasks.length);
      return;
    }
    const timers: number[] = [];
    tasks.forEach((_, i) => {
      timers.push(window.setTimeout(() => setVisibleCount(i + 1), 400 + i * 500));
    });
    return () => timers.forEach(t => clearTimeout(t));
  }, [tasks, isRunning]);

  // 主题色：思考中=紫, 冲突=橙, 通过=绿
  const accent = isConflict ? '#F5A623' : !isRunning ? '#27AE60' : '#6B63F6';
  const glow = isConflict
    ? 'rgba(245,166,35,0.32)'
    : !isRunning
      ? 'rgba(39,174,96,0.30)'
      : 'rgba(123,110,246,0.35)';

  const headerTitle = isRunning ? '小袋鼠正在接管副本' : isConflict ? '发现一个小冲突' : '执行预检完成';
  const headerSub = isRunning
    ? '正在根据你的路线安排处理导航、排号与门票'
    : isConflict
      ? `${conflictReason || '部分商家暂时无法完成排号'}，小袋鼠已为你准备替代方案`
      : '已核对营业状态、订座排号与时间衔接，未发现冲突';
  const cardTitle = isRunning ? 'Agent 执行中' : isConflict ? '冲突检测完成' : '全部已安排';
  const cardSub = isRunning
    ? '正在为你生成可执行的周末副本计划'
    : isConflict
      ? '小袋鼠正在比较距离、排队人数与营业状态'
      : '营业状态、订座与时间衔接均已确认';

  return (
    <div className="flex flex-col h-full bg-[#F7F8FC]">
      <header
        className="px-5 pb-3 flex items-center justify-between shrink-0 bg-[#F7F8FC]"
        style={{ paddingTop: 'max(44px, env(safe-area-inset-top))' }}
      >
        <button onClick={onBack} className="w-8 h-8 flex items-center justify-center text-[#1A1A2E]">
          <ChevronLeft className="w-6 h-6 stroke-[2.5]" />
        </button>
        <img src={AGENT_AVATAR} alt="小团" className="w-9 h-9 rounded-full object-contain" />
      </header>

      <div className="px-6 pb-3">
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: accent }}>{headerTitle}</h1>
        <p className="mt-1.5" style={{ fontSize: '13px', color: '#6B6F86', lineHeight: '20px' }}>
          {headerSub}
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-3 flex flex-col">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="bg-white rounded-[24px] border border-[#E8E4FF] p-6 shadow-[0_4px_20px_rgba(123,110,246,0.08)] mx-auto w-full"
          style={{ maxWidth: '342px' }}
        >
          <div className="flex flex-col items-center">
            <div className="relative">
              <div
                className="absolute inset-0 rounded-full pointer-events-none"
                style={{
                  background: `radial-gradient(circle, ${glow} 0%, transparent 70%)`,
                  filter: 'blur(14px)',
                  animation: 'agentPulse 2s ease-in-out infinite',
                }}
              />
              <img
                src={AGENT_AVATAR}
                alt="小团"
                className="relative rounded-full object-contain"
                style={{ width: '78px', height: '78px' }}
              />
            </div>
            <h2 className="mt-3" style={{ fontSize: '22px', fontWeight: 700, color: '#282447' }}>
              {cardTitle}
            </h2>
            <p className="mt-1.5 text-center" style={{ fontSize: '14px', color: '#6B6F86' }}>
              {cardSub}
            </p>
          </div>

          <div className="mt-5 rounded-[18px] p-4" style={{ background: '#F7F6FF', minHeight: '230px' }}>
            <div className="space-y-2.5">
              <AnimatePresence initial={false}>
                {tasks.slice(0, visibleCount).map((task, i) => {
                  const isCurrent = isRunning && i === visibleCount - 1 && visibleCount < tasks.length;
                  const isDone = !isRunning || i < visibleCount - 1 || visibleCount === tasks.length;
                  return (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.25 }}
                      className="flex items-start gap-2"
                    >
                      <span
                        className="shrink-0 inline-flex items-center justify-center rounded-full mt-[3px]"
                        style={{
                          width: '14px',
                          height: '14px',
                          background: isDone ? '#6B63F6' : isCurrent ? 'transparent' : '#E8E4FF',
                          border: isCurrent ? '1.5px solid #6B63F6' : 'none',
                        }}
                      >
                        {isDone && <Check className="w-[10px] h-[10px] text-white stroke-[3]" />}
                      </span>
                      <p
                        style={{
                          fontSize: '13px',
                          lineHeight: '18px',
                          color: isCurrent ? '#6B63F6' : isDone ? '#5E5B8C' : '#8A8FA8',
                          fontWeight: isCurrent ? 600 : 500,
                        }}
                      >
                        {task}
                      </p>
                    </motion.div>
                  );
                })}
              </AnimatePresence>

              {/* 结果行：检测完成后就地出现,不跳新页面 */}
              {!isRunning && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="flex items-start gap-2 pt-1"
                >
                  <span
                    className="shrink-0 inline-flex items-center justify-center rounded-full mt-[2px]"
                    style={{ width: '14px', height: '14px', background: accent }}
                  >
                    {isConflict ? (
                      <span className="text-white" style={{ fontSize: '10px', fontWeight: 800, lineHeight: 1 }}>!</span>
                    ) : (
                      <Check className="w-[10px] h-[10px] text-white stroke-[3]" />
                    )}
                  </span>
                  <p style={{ fontSize: '13px', lineHeight: '18px', color: accent, fontWeight: 600 }}>
                    {isConflict ? '检测到 1 处排号冲突，已找到替代方案' : '所有任务已排好，可以开始副本'}
                  </p>
                </motion.div>
              )}
            </div>

            {isRunning && visibleCount < tasks.length && (
              <div className="flex items-center justify-center gap-1.5 mt-4">
                {[0, 0.15, 0.3].map((d, i) => (
                  <span
                    key={i}
                    className="inline-block rounded-full"
                    style={{
                      width: '6px',
                      height: '6px',
                      background: '#6B63F6',
                      animation: `orderDot 1s ${d}s infinite ease-in-out`,
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </motion.div>

        {isRunning && (
          <p className="text-center mt-5 px-6 pb-2" style={{ fontSize: '12px', color: '#8A8FA8', lineHeight: '18px' }}>
            Agent 会按路线时间分阶段执行,不会一次性占用所有排号。
          </p>
        )}
      </div>

      {!isRunning && (
        <div
          className="shrink-0 px-6 pt-3 bg-[#F7F8FC] border-t border-[#ECEAFB]"
          style={{ paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}
        >
          <button
            onClick={onPrimary}
            className="w-full rounded-[16px] text-white active:scale-[0.98] transition-transform"
            style={{
              height: '52px',
              fontSize: '15px',
              fontWeight: 700,
              background: isConflict
                ? 'linear-gradient(to right, #F5A623, #F2994A)'
                : 'linear-gradient(to right, #7B6EF6, #5B8AF0)',
              boxShadow: '0 6px 16px rgba(107,99,246,0.30)',
            }}
          >
            {isConflict ? '查看解决方案' : '开始副本'}
          </button>
        </div>
      )}

      {isRunning && (
        <button
          aria-label="模拟排号冲突"
          onClick={onConflict}
          className="absolute"
          style={{
            right: '12px',
            bottom: '12px',
            width: '80px',
            height: '80px',
            background: 'transparent',
            opacity: 0,
            border: 'none',
            padding: 0,
            zIndex: 60,
          }}
        />
      )}

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes agentPulse {
          0%, 100% { opacity: 0.6; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.15); }
        }
      `}} />
    </div>
  );
}

const CONFLICT_LOG: { text: string; type: 'done' | 'warn' | 'progress' }[] = [
  { text: '正在确认目的地开放状态与导航路线', type: 'done' },
  { text: '目的地确认,路线已准备好', type: 'done' },
  { text: '正在查询排号状态', type: 'done' },
  { text: '该商家暂未开放线上排号', type: 'warn' },
  { text: '正在匹配附近排队更短的替代方案', type: 'progress' },
];

const PRECHECK_OK_LOG: { text: string; type: 'done' | 'warn' | 'progress' }[] = [
  { text: '目的地开放状态与导航路线已确认', type: 'done' },
  { text: '餐厅订座 / 排号状态已核对', type: 'done' },
  { text: '各节点时间衔接无冲突', type: 'done' },
  { text: '一切就绪,可以开始副本', type: 'done' },
];

function AgentConflictDetectedPage({ onBack, onResolve, conflictReason, hasConflict = true }: { onBack: () => void; onResolve: () => void; conflictReason: string; hasConflict?: boolean }) {
  const LOG = hasConflict ? CONFLICT_LOG : PRECHECK_OK_LOG;
  const [visibleCount, setVisibleCount] = useState(0);
  useEffect(() => {
    const timers: number[] = [];
    LOG.forEach((_, i) => {
      timers.push(window.setTimeout(() => setVisibleCount(i + 1), 350 + i * 450));
    });
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <div className="flex flex-col h-full bg-[#F7F8FC]">
      <header
        className="px-5 pb-3 flex items-center justify-between shrink-0 bg-[#F7F8FC]"
        style={{ paddingTop: 'max(44px, env(safe-area-inset-top))' }}
      >
        <button onClick={onBack} className="w-8 h-8 flex items-center justify-center text-[#1A1A2E]">
          <ChevronLeft className="w-6 h-6 stroke-[2.5]" />
        </button>
        <img src={AGENT_AVATAR} alt="小团" className="w-9 h-9 rounded-full object-contain" />
      </header>

      <div className="px-6 pb-3">
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#6B63F6' }}>
          {hasConflict ? '发现一个小冲突' : '执行预检完成'}
        </h1>
        <p className="mt-1.5" style={{ fontSize: '13px', color: '#6B6F86', lineHeight: '20px' }}>
          {hasConflict
            ? `${conflictReason || '暂时无法完成排号'}，小袋鼠正在为你查找替代方案。`
            : '已检查营业状态、订座排号与时间衔接，未发现冲突，可以开始副本。'}
        </p>
      </div>

      <div className="flex-1 px-6 pt-2 flex flex-col">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="bg-white rounded-[24px] border border-[#E8E4FF] p-6 shadow-[0_4px_20px_rgba(123,110,246,0.08)] mx-auto w-full"
          style={{ maxWidth: '342px' }}
        >
          <div className="flex flex-col items-center">
            <div className="relative">
              <div
                className="absolute inset-0 rounded-full pointer-events-none"
                style={{
                  background: 'radial-gradient(circle, rgba(245,166,35,0.30) 0%, transparent 70%)',
                  filter: 'blur(14px)',
                  animation: 'agentPulse 2s ease-in-out infinite',
                }}
              />
              <img
                src={AGENT_AVATAR}
                alt="小团"
                className="relative rounded-full object-contain"
                style={{ width: '78px', height: '78px' }}
              />
            </div>
            <h2 className="mt-3" style={{ fontSize: '20px', fontWeight: 700, color: '#282447' }}>
              {hasConflict ? '冲突检测中' : '预检通过'}
            </h2>
            <p className="mt-1.5 text-center" style={{ fontSize: '13px', color: '#6B6F86', lineHeight: '20px' }}>
              {hasConflict ? '小袋鼠正在比较距离、排队人数和营业状态' : '所有节点已核对完成，没有冲突'}
            </p>
          </div>

          <div className="mt-5 rounded-[18px] p-4" style={{ background: '#F7F6FF', minHeight: '210px' }}>
            <div className="space-y-2.5">
              {LOG.slice(0, visibleCount).map((item, i) => {
                const color =
                  item.type === 'warn' ? '#F5A623' :
                  item.type === 'progress' ? '#6B63F6' :
                  '#5E5B8C';
                return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25 }}
                    className="flex items-start gap-2"
                  >
                    <span
                      className="shrink-0 inline-flex items-center justify-center rounded-full mt-[2px]"
                      style={{
                        width: '14px',
                        height: '14px',
                        background: item.type === 'done' ? '#6B63F6' : item.type === 'warn' ? '#F5A623' : 'transparent',
                        border: item.type === 'progress' ? '1.5px solid #6B63F6' : 'none',
                      }}
                    >
                      {item.type === 'done' && <Check className="w-[10px] h-[10px] text-white stroke-[3]" />}
                      {item.type === 'warn' && (
                        <span className="text-white" style={{ fontSize: '10px', fontWeight: 800, lineHeight: 1 }}>!</span>
                      )}
                    </span>
                    <p style={{ fontSize: '13px', lineHeight: '18px', color, fontWeight: item.type === 'progress' ? 600 : 500 }}>
                      {item.text}
                    </p>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </motion.div>

        <div className="mt-auto pt-4 pb-6">
          <button
            onClick={onResolve}
            className="w-full rounded-[16px] bg-gradient-to-r from-[#7B6EF6] to-[#5B8AF0] text-white active:scale-[0.98] transition-transform"
            style={{ height: '52px', fontSize: '15px', fontWeight: 700, boxShadow: '0 6px 16px rgba(107,99,246,0.30)' }}
          >
            {hasConflict ? '查看解决方案' : '开始副本'}
          </button>
        </div>
      </div>
    </div>
  );
}

const DEFAULT_CONFLICT_SOLUTIONS = [
  {
    title: '换一家排队更短的店',
    desc: '替换为备选店，距离相近，当前预计排队较短。',
    tags: ['推荐', '排队更短', '不影响后续行程'],
    button: '采用这个方案',
    recommended: true,
  },
  {
    title: '延后 30 分钟再尝试排号',
    desc: '保留原店，将在接近到达时间时再次尝试排号。',
    tags: ['保留原店', '稍后重试'],
    button: '稍后再试',
    recommended: false,
  },
  {
    title: '跳过该节点',
    desc: '直接前往下一站，Agent 会重新调整路线时间。',
    tags: ['节省时间', '重新规划'],
    button: '跳过这一站',
    recommended: false,
  },
];

function ConflictResolvePage({
  onBack,
  onAdopt,
  conflictReason,
  solutions = DEFAULT_CONFLICT_SOLUTIONS,
}: {
  onBack: () => void;
  onAdopt: (which: 0 | 1 | 2) => void;
  conflictReason: string;
  solutions?: Array<{
    title: string;
    desc: string;
    tags: string[];
    button: string;
    recommended: boolean;
  }>;
}) {
  return (
    <div className="flex flex-col h-full bg-[#F7F8FC]">
      <header
        className="px-5 pb-3 flex items-center justify-between shrink-0 bg-[#F7F8FC]"
        style={{ paddingTop: 'max(44px, env(safe-area-inset-top))' }}
      >
        <button onClick={onBack} className="w-8 h-8 flex items-center justify-center text-[#1A1A2E]">
          <ChevronLeft className="w-6 h-6 stroke-[2.5]" />
        </button>
        <img src={AGENT_AVATAR} alt="小团" className="w-9 h-9 rounded-full object-contain" />
      </header>

      <div className="px-6 pb-1">
        <h1 style={{ fontSize: '24px', fontWeight: 800, color: '#6B63F6', letterSpacing: '-0.4px' }}>
          需要你确认一下
        </h1>
        <p className="mt-1.5" style={{ fontSize: '13px', color: '#6B6F86', lineHeight: '20px' }}>
          小袋鼠发现路线中有一个节点需要调整
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pt-4 pb-10" style={{ scrollbarWidth: 'none' }}>
        <div className="bg-white rounded-[22px] border border-[#E8E4FF] shadow-[0_4px_18px_rgba(123,110,246,0.06)] p-5">
          <div className="flex items-start gap-2.5">
            <div className="shrink-0 rounded-full flex items-center justify-center mt-0.5" style={{ width: '24px', height: '24px', background: '#FFF3E0' }}>
              <span style={{ fontSize: '13px', fontWeight: 800, color: '#F5A623', lineHeight: 1 }}>!</span>
            </div>
            <div className="flex-1 min-w-0">
              <h2 style={{ fontSize: '17px', fontWeight: 800, color: '#282447' }}>
                {conflictReason || '轻食补给排号失败'}
              </h2>
              <p className="mt-1" style={{ fontSize: '13px', color: '#6B6F86', lineHeight: '20px' }}>
                {conflictReason ? `${conflictReason}，可能会影响后续行程。` : '原计划的轻食店暂未开放线上排号，可能会影响中午补给时间。'}
              </p>
            </div>
          </div>

          <div className="mt-4 border-t border-dashed border-[#E8E4FF] pt-3 space-y-3">
            {[
              { label: '冲突原因', value: conflictReason || '商家暂未开放排号' },
              { label: '影响', value: '预计到店后可能需要现场等待' },
              { label: 'Agent 判断', value: '建议更换为附近排队更短的同类型店，避免影响后续行程。' },
            ].map(row => (
              <div key={row.label}>
                <p style={{ fontSize: '12px', fontWeight: 700, color: '#6B63F6' }}>{row.label}</p>
                <p className="mt-0.5" style={{ fontSize: '13px', color: '#6B6F86', lineHeight: '19px' }}>{row.value}</p>
              </div>
            ))}
          </div>
        </div>

        <h3 className="mt-5 mb-2" style={{ fontSize: '15px', fontWeight: 800, color: '#282447' }}>
          可选解决方案
        </h3>

        <div className="space-y-3">
          {solutions.map((sol, i) => {
            const recommended = sol.recommended;
            return (
              <div
                key={i}
                className="rounded-[18px] p-4"
                style={{
                  background: recommended ? '#F3F0FF' : '#FFFFFF',
                  border: `1.5px solid ${recommended ? '#6B63F6' : '#E8E4FF'}`,
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <h4 style={{ fontSize: '15px', fontWeight: 800, color: '#282447', lineHeight: '20px' }}>
                    {sol.title}
                  </h4>
                  {recommended && (
                    <span
                      className="shrink-0 rounded-full"
                      style={{
                        background: 'linear-gradient(135deg, #7B6EF6 0%, #5B8AF0 100%)',
                        color: 'white',
                        fontSize: '10.5px',
                        fontWeight: 800,
                        padding: '2px 8px',
                      }}
                    >
                      推荐
                    </span>
                  )}
                </div>
                <p className="mt-1.5" style={{ fontSize: '12.5px', color: '#6B6F86', lineHeight: '18px' }}>
                  {sol.desc}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {sol.tags.map(tag => (
                    <span
                      key={tag}
                      className="rounded-full"
                      style={{
                        fontSize: '10.5px',
                        fontWeight: 600,
                        padding: '2px 8px',
                        background: recommended ? 'rgba(107,99,246,0.12)' : '#F4F1FF',
                        color: '#6B63F6',
                      }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                <button
                  onClick={() => onAdopt(i as 0 | 1 | 2)}
                  className={
                    recommended
                      ? 'mt-3 w-full rounded-[14px] bg-gradient-to-r from-[#7B6EF6] to-[#5B8AF0] text-white active:scale-[0.98] transition-transform'
                      : 'mt-3 w-full rounded-[14px] bg-white active:scale-[0.98] transition-transform'
                  }
                  style={{
                    height: '40px',
                    fontSize: '13px',
                    fontWeight: 700,
                    border: recommended ? 'none' : '1.5px solid #D8D3FF',
                    color: recommended ? 'white' : '#6B63F6',
                    boxShadow: recommended ? '0 6px 14px rgba(107,99,246,0.30)' : 'none',
                  }}
                >
                  {sol.button}
                </button>
              </div>
            );
          })}
        </div>

        <p className="text-center mt-5" style={{ fontSize: '11.5px', color: '#8A8FA8', lineHeight: '17px' }}>
          小袋鼠会根据排队状态、营业时间、票务余量和你的当前位置,自动识别并处理路线冲突。
        </p>
      </div>
    </div>
  );
}


// ============================================================================
// Figma 增量界面：核销成功浮层 + 副本通关结果页
// TODO: 以下页面内的文案/数字均为 mock 演示数据，后续接后端真实数据时替换：
//   河畔日落漫游 / 完成时间 2026-06-05 18:45 / 票据编号 T20260605184512345 /
//   游玩时长 7.2 小时 / 总步行 6.2km / 打卡 4 个 / 支付金额 ¥39.00 / 奖励项 等。
// 视觉、PNG、光效、动画完全来自 Figma，未做改动。
// ============================================================================
function MissionCompleteOverlayPage({ onTapAnywhere, routeName }: { onTapAnywhere: () => void; routeName: string }) {
  const extraStars: Array<{ x: number; y: number; size: number; opacity: number; fill: string; blur: number; kind: 'four' | 'five' }> = [
    { x: 122, y: 254, size: 11, opacity: 0.90, fill: 'rgba(255,255,255,0.86)', blur: 0.8, kind: 'four' },
    { x: 262, y: 258, size: 10, opacity: 0.78, fill: 'rgba(255,255,255,0.78)', blur: 0.8, kind: 'four' },
    { x: 102, y: 316, size: 14, opacity: 0.70, fill: 'rgba(255,216,74,0.58)',  blur: 0.6, kind: 'five' },
    { x: 286, y: 322, size: 16, opacity: 0.66, fill: 'rgba(255,216,74,0.52)',  blur: 0.6, kind: 'five' },
    { x: 124, y: 376, size: 9,  opacity: 0.65, fill: 'rgba(255,255,255,0.58)', blur: 0.8, kind: 'four' },
    { x: 268, y: 382, size: 9,  opacity: 0.62, fill: 'rgba(255,255,255,0.55)', blur: 0.8, kind: 'four' },
  ];

  const dust: Array<{ x: number; y: number; size: number }> = [
    { x: 144, y: 264, size: 4 },
    { x: 246, y: 266, size: 4 },
    { x: 162, y: 326, size: 3 },
    { x: 232, y: 328, size: 3 },
    { x: 118, y: 304, size: 3 },
    { x: 276, y: 306, size: 3 },
    { x: 182, y: 240, size: 3 },
    { x: 212, y: 240, size: 3 },
    { x: 150, y: 356, size: 2 },
    { x: 242, y: 356, size: 2 },
  ];

  const FiveStar = ({ size, fill }: { size: number; fill: string }) => (
    <svg width={size} height={size} viewBox="0 0 54 54">
      <polygon
        points="27,3 33.5,21 52,21 37,32 42.5,50 27,39 11.5,50 17,32 2,21 20.5,21"
        fill={fill}
      />
    </svg>
  );

  const FourStar = ({ size, fill }: { size: number; fill: string }) => (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path d="M12 0 L13.6 10.4 L24 12 L13.6 13.6 L12 24 L10.4 13.6 L0 12 L10.4 10.4 Z" fill={fill} />
    </svg>
  );

  const rayAngles = [
    0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5,
    180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5,
  ];

  return (
    <div
      data-layer-name="MissionCompleteOverlayPage"
      className="overflow-hidden"
      style={{ position: 'fixed', inset: 0, zIndex: 80 }}
    >
      <div
        data-layer-name="BackgroundBlur"
        className="absolute inset-0 pointer-events-none"
        style={{
          backdropFilter: 'blur(18px)',
          WebkitBackdropFilter: 'blur(18px)',
        }}
      />

      <div
        data-layer-name="DarkOverlay"
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'rgba(18, 18, 32, 0.44)' }}
      />

      <div
        data-layer-name="MissionCompleteContent"
        className="absolute"
        style={{
          left: '50%',
          top: '50%',
          width: 393,
          height: 852,
          transform: 'translate(-50%, -50%)',
          overflow: 'visible',
        }}
      >
        <div
          data-layer-name="MainStar_WideWarmHalo"
          className="absolute pointer-events-none"
          style={{
            left: 62, top: 152, width: 268, height: 268,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(255,216,74,0.28) 0%, rgba(255,180,60,0.13) 48%, rgba(255,216,74,0) 100%)',
            filter: 'blur(34px)',
            mixBlendMode: 'screen',
            opacity: 0.82,
          }}
        />

        {rayAngles.map((deg) => (
          <div
            key={deg}
            data-layer-name="MainStar_RadialRays"
            className="absolute pointer-events-none"
            style={{
              left: 196, top: 286,
              width: 3, height: 150,
              marginLeft: -1.5, marginTop: -75,
              borderRadius: 999,
              background: 'linear-gradient(to bottom, rgba(255,245,180,0) 0%, rgba(255,216,74,0.30) 50%, rgba(255,245,180,0) 100%)',
              filter: 'blur(8px)',
              mixBlendMode: 'screen',
              opacity: 0.68,
              transform: `rotate(${deg}deg)`,
              transformOrigin: 'center center',
            }}
          />
        ))}

        <div
          data-layer-name="MainStar_GoldenGlow"
          className="absolute pointer-events-none"
          style={{
            left: 128, top: 218, width: 136, height: 136,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(255,232,90,0.62) 0%, rgba(255,198,54,0.34) 45%, rgba(255,216,74,0) 100%)',
            filter: 'blur(18px)',
            mixBlendMode: 'screen',
            opacity: 0.95,
          }}
        />

        <div
          data-layer-name="MainStar_CoreWhiteGlow"
          className="absolute pointer-events-none"
          style={{
            left: 156, top: 246, width: 80, height: 80,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(255,255,255,0.82) 0%, rgba(255,245,165,0.56) 38%, rgba(255,216,74,0) 100%)',
            filter: 'blur(10px)',
            mixBlendMode: 'screen',
            opacity: 0.9,
          }}
        />

        {dust.map((d, idx) => (
          <div
            key={`dust-${idx}`}
            data-layer-name="MainStar_Static_Dust"
            className="absolute pointer-events-none"
            style={{
              left: d.x, top: d.y,
              width: d.size, height: d.size,
              borderRadius: '50%',
              background: 'rgba(255,240,170,0.78)',
              filter: 'blur(1px)',
              mixBlendMode: 'screen',
            }}
          />
        ))}

        <motion.div
          data-layer-name="Flowing_Glow_Under_TitleStar"
          className="absolute pointer-events-none"
          style={{
            top: 218, width: 160, height: 88,
            borderRadius: '50%',
            background: 'linear-gradient(to right, rgba(255,216,74,0) 0%, rgba(255,245,160,0.38) 50%, rgba(255,216,74,0) 100%)',
            filter: 'blur(22px)',
            mixBlendMode: 'screen',
            left: 0,
          }}
          initial={{ opacity: 0, x: 30 }}
          animate={{
            opacity: [0, 0.65, 0.65, 0],
            x: [30, 30, 205, 235],
          }}
          transition={{
            duration: 1.5,
            times: [0, 0.28, 0.733, 1],
            ease: 'easeOut',
          }}
        />

        <motion.img
          data-layer-name="MissionComplete_TitleStar_PNG"
          src={MISSION_TITLE_STAR_PNG}
          alt="副本通关"
          className="absolute object-contain pointer-events-none"
          style={{
            left: 42,
            top: 116,
            width: 310,
            height: 'auto',
            filter:
              'drop-shadow(0px 0px 8px rgba(255,216,74,0.28)) drop-shadow(0px 4px 10px rgba(45,20,95,0.30))',
          }}
          initial={{ opacity: 0, scale: 0.84, y: 22 }}
          animate={{
            opacity: [0, 1, 1, 1],
            scale: [0.84, 1.07, 0.98, 1.0],
            y: [22, -6, 3, 0],
          }}
          transition={{
            duration: 0.56,
            times: [0, 0.43, 0.71, 1],
            ease: 'easeOut',
          }}
        />

        <motion.div
          data-layer-name="TitleStar_Soft_Sweep"
          className="absolute pointer-events-none"
          style={{
            top: 112,
            width: 58,
            height: 170,
            borderRadius: 999,
            background: 'linear-gradient(to right, rgba(255,255,255,0) 0%, rgba(255,255,255,0.42) 50%, rgba(255,255,255,0) 100%)',
            filter: 'blur(10px)',
            mixBlendMode: 'screen',
            transform: 'rotate(-18deg)',
            transformOrigin: 'center center',
            left: 0,
          }}
          initial={{ opacity: 0, x: 36 }}
          animate={{
            opacity: [0, 0.5, 0.5, 0],
            x: [36, 80, 300, 300],
          }}
          transition={{
            duration: 0.93,
            delay: 0.52,
            times: [0, 0.17, 0.785, 1],
            ease: 'easeOut',
          }}
        />

        {extraStars.map((s, idx) => (
          <div
            key={`xstar-${idx}`}
            data-layer-name="Extra_Stars_Around_MainStar"
            className="absolute pointer-events-none"
            style={{
              left: s.x,
              top: s.y,
              opacity: s.opacity,
              filter: `blur(${s.blur}px)`,
            }}
          >
            {s.kind === 'four'
              ? <FourStar size={s.size} fill={s.fill} />
              : <FiveStar size={s.size} fill={s.fill} />}
          </div>
        ))}

        <motion.img
          data-layer-name="Kangaroo_PNG"
          src={SUCCESS_IP}
          alt="小团"
          className="absolute object-contain pointer-events-none"
          style={{
            left: 118,
            top: 320,
            width: 158,
            height: 'auto',
            filter: 'drop-shadow(0px 14px 24px rgba(0,0,0,0.24)) drop-shadow(0px 0px 22px rgba(255,216,74,0.45))',
          }}
          initial={{ opacity: 0, scale: 0.82, y: 42 }}
          animate={{
            opacity: [0, 1, 1, 1, 1],
            scale: [0.82, 1.08, 0.96, 1.02, 1.0],
            y: [42, -26, 10, -4, 0],
          }}
          transition={{
            duration: 0.6,
            times: [0, 0.3, 0.53, 0.77, 1],
            ease: 'easeOut',
          }}
        />

        <motion.div
          data-layer-name="Subtitle"
          className="absolute pointer-events-none"
          style={{
            left: 0,
            top: 548,
            width: 393,
            textAlign: 'center',
            color: '#FFFFFF',
            fontSize: 17,
            fontWeight: 700,
            lineHeight: '24px',
            textShadow: '0px 2px 8px rgba(0,0,0,0.35)',
          }}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.55, ease: 'easeOut' }}
        >
          恭喜完成「{routeName}」
        </motion.div>

        <motion.div
          className="absolute pointer-events-none"
          style={{
            left: 0,
            top: 688,
            width: 393,
            textAlign: 'center',
            color: 'rgba(255,255,255,0.72)',
            fontSize: 14,
            fontWeight: 500,
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.85, ease: 'easeOut' }}
        >
          点击任意位置继续
        </motion.div>
      </div>

      <button
        data-layer-name="TapAnywhere_To_SuccessCompletionPage"
        onClick={onTapAnywhere}
        aria-label="点击任意位置继续"
        className="absolute inset-0 w-full h-full"
        style={{ background: 'transparent', cursor: 'pointer', border: 'none', padding: 0 }}
      />
    </div>
  );
}

type CompletionData = {
  routeName: string;
  dungeonType: string;
  dungeonTag: string;
  coverImg: string;
  completedAt: string;
  ticketNo: string;
  stats: { duration: string; walk: string; spots: string; calories: string };
  ticketRows: Array<{ label: string; value: string }>;
};

function SuccessCompletionPage({ onBackToHome, data }: { onBackToHome: () => void; data: CompletionData }) {
  const rewards = [
    { icon: Castle, title: '城市漫游者', desc: '经验值 +30' },
    { icon: Sparkles, title: '探索达人', desc: '成就徽章 ×1' },
    { icon: Flag, title: '周末玩家', desc: '活力积分 +15' },
  ];

  const { routeName, dungeonType, dungeonTag, coverImg, completedAt, ticketNo, stats, ticketRows } = data;

  return (
    <div className="relative flex flex-col w-full h-full bg-[#F7F8FC] overflow-hidden">
      <div className="relative shrink-0 px-5" style={{ paddingTop: 56, paddingBottom: 12 }}>
        <button onClick={onBackToHome} className="flex items-center justify-center" style={{ width: 28, height: 28 }}>
          <ChevronLeft className="w-7 h-7 text-[#1A1A2E] stroke-[2.5]" />
        </button>
        <button
          onClick={() => toast('打卡海报已生成，可截图分享给好友~', { duration: 1800 })}
          className="absolute flex items-center justify-center"
          style={{ right: 20, top: 56, width: 28, height: 28 }}
        >
          <Share className="w-6 h-6 text-[#1A1A2E] stroke-[2.5]" />
        </button>

        <img
          src={SUCCESS_IP}
          alt="小团"
          className="absolute object-contain pointer-events-none"
          style={{
            right: 19, top: 72, width: 88, height: 'auto',
            filter: 'drop-shadow(0px 8px 18px rgba(91, 70, 232, 0.18))',
          }}
        />

        <div style={{ marginTop: 10, width: 220 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, lineHeight: '36px', color: '#5B46E8', letterSpacing: 0 }}>
            核销成功，<br />副本通关！
          </h1>
          <p style={{ marginTop: 6, fontSize: 14, fontWeight: 500, lineHeight: '22px', color: '#6E6A90' }}>
            感谢游玩 · {dungeonType}
          </p>
          <p style={{ fontSize: 14, fontWeight: 500, lineHeight: '22px', color: '#6E6A90' }}>
            虚拟打卡票据已生成，可分享纪念
          </p>
        </div>
      </div>

      <div
        className="flex-1 min-h-0 overflow-y-auto px-5"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', paddingTop: 12, paddingBottom: 120 }}
      >
        <div
          className="bg-white flex flex-col"
          style={{ borderRadius: 24, padding: 16, gap: 18, boxShadow: '0px 8px 28px rgba(123, 110, 246, 0.12)' }}
        >
          <div className="flex" style={{ gap: 14 }}>
            <img
              src={coverImg}
              className="object-cover shrink-0"
              style={{ width: 104, height: 104, borderRadius: 14 }}
              alt="副本封面"
            />
            <div className="flex flex-col flex-1 min-w-0" style={{ gap: 8 }}>
              <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1A1A2E' }}>{routeName}</h2>
                <span style={{ padding: '2px 8px', background: '#EFEAFF', color: '#6B5BDB', borderRadius: 8, fontSize: 12, whiteSpace: 'nowrap' }}>
                  {dungeonTag}
                </span>
              </div>
              <div className="grid grid-cols-2" style={{ columnGap: 18, rowGap: 12, marginTop: 2 }}>
                {[
                  { k: '游玩时长', v: stats.duration },
                  { k: '总步行', v: stats.walk },
                  { k: '打卡地点', v: stats.spots },
                  { k: '消耗卡路里', v: stats.calories },
                ].map((d) => (
                  <div key={d.k} className="min-w-0">
                    <p style={{ fontSize: 13, color: '#6E6A90', marginBottom: 2 }}>{d.k}</p>
                    <p style={{ fontSize: 16, fontWeight: 600, color: '#3A335F' }}>{d.v}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center" style={{ gap: 12, paddingTop: 12, borderTop: '1px solid #E8E3FA' }}>
            <div
              className="rounded-full flex items-center justify-center shrink-0"
              style={{ width: 44, height: 44, background: 'linear-gradient(135deg, #7B6EF6 0%, #5B8AF0 100%)' }}
            >
              <Check className="w-6 h-6 text-white stroke-[3]" />
            </div>
            <div className="flex-1 min-w-0">
              <p style={{ fontSize: 13, color: '#8A84A8' }}>副本状态</p>
              <p style={{ fontSize: 22, fontWeight: 700, color: '#5B46E8', lineHeight: '28px' }}>副本通关</p>
            </div>
            <div className="text-right shrink-0" style={{ width: 120 }}>
              <p style={{ fontSize: 13, color: '#8A84A8' }}>完成时间</p>
              <p style={{ fontSize: 14, fontWeight: 500, color: '#6E6A90' }}>{completedAt}</p>
            </div>
          </div>

          <div className="relative flex items-center" style={{ height: 20, marginLeft: -16, marginRight: -16 }}>
            <div style={{ width: 12, height: 20, background: '#F7F8FC', borderRadius: '0 10px 10px 0' }} />
            <div className="flex-1 border-t-[1.5px] border-dashed border-[#DCD3FF]" />
            <div style={{ width: 12, height: 20, background: '#F7F8FC', borderRadius: '10px 0 0 10px' }} />
          </div>

          <div className="relative flex flex-col" style={{ gap: 12 }}>
            <div className="flex items-center justify-between">
              <h3 style={{ fontSize: 20, fontWeight: 700, color: '#1A1A2E' }}>虚拟打卡票据</h3>
              <div
                className="flex items-center justify-center shrink-0"
                style={{ width: 56, height: 24, background: '#E7F8E8', color: '#35A853', borderRadius: 8, fontSize: 13, fontWeight: 600 }}
              >
                已完成
              </div>
            </div>
            <p style={{ fontSize: 13, color: '#6E6A90' }}>打卡编号：{ticketNo}</p>

            <div className="flex flex-col" style={{ gap: 10 }}>
              {ticketRows.map((row) => (
                <div key={row.label} className="flex items-start" style={{ gap: 10 }}>
                  <div className="rounded-full bg-[#F4F1FF] flex items-center justify-center shrink-0" style={{ width: 16, height: 16, marginTop: 3 }}>
                    <Check className="w-2.5 h-2.5 text-[#6B5BDB] stroke-[3]" />
                  </div>
                  <span className="shrink-0" style={{ width: 72, fontSize: 14, color: '#8A84A8' }}>{row.label}</span>
                  <span className="flex-1 min-w-0 break-words" style={{ fontSize: 15, fontWeight: 600, color: '#1A1A2E' }}>{row.value}</span>
                </div>
              ))}
            </div>

            <div
              className="absolute flex items-center justify-center rounded-full pointer-events-none"
              style={{
                right: 14, top: 78, width: 82, height: 82,
                border: '2px solid #9B8CFF', color: '#9B8CFF', opacity: 0.65,
                transform: 'rotate(-8deg)', zIndex: 0,
              }}
            >
              <div className="absolute rounded-full" style={{ width: 74, height: 74, border: '1px solid #9B8CFF' }} />
              <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: 1 }}>副本通关</span>
            </div>
          </div>

          <div
            className="flex flex-col"
            style={{
              padding: 14, borderRadius: 18, gap: 12,
              background: 'linear-gradient(135deg, rgba(123,110,246,0.10) 0%, rgba(91,138,240,0.08) 100%)',
            }}
          >
            <h4 style={{ fontSize: 16, fontWeight: 700, color: '#5B46E8' }}>🎉 恭喜通关，获得以下奖励</h4>
            <div className="flex" style={{ gap: 8 }}>
              {rewards.map((r) => (
                <div
                  key={r.title}
                  className="bg-white flex items-center flex-1 min-w-0"
                  style={{ height: 58, borderRadius: 14, padding: 8, gap: 8, boxShadow: '0px 4px 12px rgba(123,110,246,0.10)' }}
                >
                  <div className="rounded-full bg-[#F1EEFF] flex items-center justify-center shrink-0" style={{ width: 28, height: 28 }}>
                    <r.icon className="w-4 h-4 text-[#6B5BDB]" />
                  </div>
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="truncate" style={{ fontSize: 12, fontWeight: 600, color: '#1A1A2E' }}>{r.title}</span>
                    <span className="truncate" style={{ fontSize: 11, color: '#6E6A90' }}>{r.desc}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div
        className="absolute left-0 right-0 bottom-0 flex"
        style={{
          height: 88,
          gap: 12,
          paddingLeft: 20, paddingRight: 20, paddingTop: 12,
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
          background: 'rgba(247, 248, 252, 0.92)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderTop: '1px solid rgba(220, 211, 255, 0.5)',
        }}
      >
        <button
          onClick={onBackToHome}
          className="flex-1 flex items-center justify-center active:scale-[0.98] transition-transform shadow-[0_6px_16px_rgba(107,99,246,0.30)]"
          style={{
            height: 56, borderRadius: 18,
            background: 'linear-gradient(135deg, #7B6EF6 0%, #5B8AF0 100%)',
            color: '#FFFFFF', fontSize: 18, fontWeight: 600,
          }}
        >
          返回首页
        </button>
      </div>
    </div>
  );
}

function VoucherPage({
  index,
  onBack,
  tasks,
  voucherCode,
  onVerify,
}: {
  index: number;
  onBack: () => void;
  tasks: Array<UiExecutionTask & { image: string; statusColor: string }>;
  voucherCode: string;
  onVerify?: () => void;
}) {
  const task = tasks[index];
  return (
    <div className="flex flex-col h-full bg-[#F7F8FC]">
      <header
        className="px-5 pb-3 flex items-center shrink-0 bg-[#F7F8FC]"
        style={{ paddingTop: 'max(44px, env(safe-area-inset-top))' }}
      >
        <button onClick={onBack} className="w-8 h-8 flex items-center justify-center text-[#1A1A2E] mr-2">
          <ChevronLeft className="w-6 h-6 stroke-[2.5]" />
        </button>
        <h1 className="font-bold text-[18px] tracking-wide" style={{ color: '#6B63F6' }}>核销码</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-6 pt-2 pb-10">
        <div className="bg-white rounded-[24px] border border-[#E8E4FF] shadow-[0_4px_20px_rgba(123,110,246,0.06)] p-6 flex flex-col items-center">
          <p style={{ fontSize: '13px', fontWeight: 700, color: '#6B63F6' }}>{task.voucherLabel}</p>
          <h2 className="mt-1.5" style={{ fontSize: '20px', fontWeight: 800, color: '#282447' }}>
            {task.place}
          </h2>
          <button
            onClick={onVerify}
            aria-label="点击核销码完成核销"
            className="mt-5 rounded-[20px] flex items-center justify-center active:scale-[0.98] transition-transform"
            style={{ width: '220px', height: '220px', background: '#F7F6FF', border: '1px solid #E8E4FF', cursor: 'pointer' }}
          >
            <div className="flex flex-col items-center">
              <QrCode className="w-[130px] h-[130px]" style={{ color: '#282447' }} strokeWidth={1.5} />
              <p className="mt-2 text-[11px] text-[#6B6F86]">{voucherCode}</p>
            </div>
          </button>
          <p className="mt-4 text-center" style={{ fontSize: '12.5px', color: '#6B6F86', lineHeight: '18px' }}>
            到店出示此凭证即可完成{task.voucherLabel}。Agent 会在临近时间自动提醒你。
          </p>
          <button
            onClick={onVerify}
            className="mt-3 w-full flex items-center justify-center active:scale-[0.98] transition-transform"
            style={{
              height: 48, borderRadius: 14,
              background: 'linear-gradient(135deg, #7B6EF6 0%, #5B8AF0 100%)',
              color: '#FFFFFF', fontSize: 15, fontWeight: 700,
              boxShadow: '0 6px 16px rgba(107,99,246,0.30)',
            }}
          >
            点击核销码完成核销
          </button>
        </div>
      </div>
    </div>
  );
}

function AgentExecutionPage({
  onBack,
  onOpenVoucher,
  tasksInput,
  variant = 'normal',
  places,
  origin,
}: {
  onBack: () => void;
  onOpenVoucher: (i: number) => void;
  tasksInput: Array<UiExecutionTask & { image: string; statusColor: string }>;
  variant?: 'normal' | 'updated';
  places?: Array<UiPlace>;
  origin?: string;
}) {
  const isUpdated = variant === 'updated';
  const nextStopName = tasksInput[1]?.place || tasksInput[0]?.place || '目的地';
  const arrivalTime = tasksInput[0]?.description?.match(/(\d{1,2}:\d{2})/)?.[1] || '';
  const tasks = tasksInput;
  return (
    <div className="flex flex-col h-full bg-[#F7F8FC]">
      <header
        className="px-5 pb-3 flex items-center justify-between shrink-0 bg-[#F7F8FC]"
        style={{ paddingTop: 'max(44px, env(safe-area-inset-top))' }}
      >
        <button onClick={onBack} className="w-8 h-8 flex items-center justify-center text-[#1A1A2E]">
          <ChevronLeft className="w-6 h-6 stroke-[2.5]" />
        </button>
        <img src={AGENT_AVATAR} alt="小团" className="w-9 h-9 rounded-full object-contain" />
      </header>

      <div className="px-6 pb-1">
        <h1 style={{ fontSize: '26px', fontWeight: 800, color: '#6B63F6', letterSpacing: '-0.5px' }}>
          副本进行中（实时任务）
        </h1>
        <p className="mt-1.5" style={{ fontSize: '13px', color: '#6B6F86', lineHeight: '20px' }}>
          {tasksInput.length}项任务｜你的副本启动分阶段执行,按时间触发任务
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pt-[22px] pb-10" style={{ scrollbarWidth: 'none' }}>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="bg-white rounded-[24px] border border-[#E8E4FF] shadow-[0_4px_18px_rgba(123,110,246,0.06)] overflow-hidden"
        >
          <div className="relative" style={{ height: '240px' }}>
            <RouteMap
              origin={origin}
              places={(places || []).map((p) => ({ name: p.place_title, location: p.location }))}
              height={240}
            />

            <div
              className="absolute bg-white rounded-[18px]"
              style={{
                left: '14px',
                bottom: '14px',
                width: '210px',
                padding: '12px 14px',
                boxShadow: '0 8px 20px rgba(123,110,246,0.18)',
                zIndex: 10,
              }}
            >
              <p style={{ fontSize: '11px', fontWeight: 700, color: '#6B63F6' }}>当前任务</p>
              <h3 className="mt-0.5" style={{ fontSize: '15px', fontWeight: 800, color: '#282447', lineHeight: '20px' }}>
                前往「{tasks[0]?.place || '目的地'}」
              </h3>
              <p className="mt-0.5" style={{ fontSize: '11px', color: '#6B6F86' }}>
                {tasks[0]?.description?.split('\n')[0] || ''}
              </p>
            </div>
          </div>

          <div className="px-4 pt-3 pb-3">
            <button
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-[14px] bg-gradient-to-r from-[#7B6EF6] to-[#5B8AF0] text-white active:scale-[0.98] transition-transform"
              style={{ height: '40px', fontSize: '14px', fontWeight: 700, boxShadow: '0 6px 14px rgba(107,99,246,0.30)' }}
              onClick={() => toast('导航功能开发中，敬请期待', { duration: 1500 })}
            >
              <Send className="w-4 h-4" strokeWidth={2.4} />
              开始导航
            </button>
          </div>

          <div className="mx-3 mb-3 flex items-center rounded-[18px]" style={{ background: '#FAF9FF', height: '64px', padding: '0 16px' }}>
            <div className="shrink-0 rounded-full flex items-center justify-center" style={{ width: '32px', height: '32px', background: '#F1EEFF' }}>
              <MapPin className="w-4 h-4" style={{ color: '#6B63F6' }} strokeWidth={2.4} />
            </div>
            <div className="flex-1 ml-3 min-w-0">
              <p style={{ fontSize: '11px', color: '#6B6F86' }}>下一站</p>
              <p style={{ fontSize: '14px', fontWeight: 800, color: '#282447' }}>{nextStopName}</p>
            </div>
            {arrivalTime && <p className="mx-2" style={{ fontSize: '12px', color: '#6B6F86' }}>预计 {arrivalTime} 到达</p>}
            <ChevronRight className="w-4 h-4 shrink-0" style={{ color: '#6B63F6' }} strokeWidth={2.4} />
          </div>
        </motion.div>

        <div className="space-y-3 mt-4">
          {tasks.map((task, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.08 + i * 0.06 }}
              className="bg-white rounded-[18px] border border-[#E8E4FF] shadow-[0_4px_14px_rgba(123,110,246,0.05)] p-3 flex gap-3 items-center"
            >
              <div className="relative shrink-0 rounded-[12px] overflow-hidden" style={{ width: '92px', height: '72px' }}>
                <img src={task.image} alt={task.place} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                <div
                  className="absolute flex items-center justify-center text-white bg-gradient-to-br from-[#7B6EF6] to-[#5B8AF0]"
                  style={{ top: '6px', left: '6px', width: '22px', height: '22px', borderRadius: '8px', fontSize: '12px', fontWeight: 800 }}
                >
                  {i + 1}
                </div>
              </div>

              <div className="flex-1 min-w-0">
                <h3 style={{ fontSize: '15px', fontWeight: 700, color: '#282447', lineHeight: '20px' }}>
                  {task.place}
                </h3>
                <p className="mt-0.5" style={{ fontSize: '12px', fontWeight: 700, color: task.statusColor }}>
                  {task.statusLabel || task.status}
                </p>
                <p className="mt-0.5 whitespace-pre-line" style={{ fontSize: '11.5px', color: '#6B6F86', lineHeight: '16px' }}>
                  {task.description}
                </p>
              </div>

              <div className="flex flex-col gap-2 shrink-0">
                <button
                  onClick={() => toast('一键打车功能开发中，敬请期待', { duration: 1500 })}
                  className="inline-flex items-center justify-center gap-1 rounded-[12px] bg-white border active:scale-[0.96] transition-transform"
                  style={{
                    width: '74px',
                    height: '34px',
                    borderColor: '#D8D3FF',
                    color: '#6B63F6',
                    fontSize: '12px',
                    fontWeight: 700,
                  }}
                >
                  <Send className="w-3.5 h-3.5" strokeWidth={2.4} />
                  一键打车
                </button>
                <button
                  onClick={() => onOpenVoucher(i)}
                  className="inline-flex items-center justify-center gap-1 rounded-[12px] bg-white border active:scale-[0.96] transition-transform"
                  style={{
                    width: '74px',
                    height: '34px',
                    borderColor: '#D8D3FF',
                    color: '#6B63F6',
                    fontSize: '12px',
                    fontWeight: 700,
                    opacity: task.voucherDim ? 0.6 : 1,
                  }}
                >
                  <QrCode className="w-3.5 h-3.5" strokeWidth={2.2} />
                  核销码
                </button>
              </div>
            </motion.div>
          ))}
        </div>

        {isUpdated && (
          <div className="mt-5 flex items-center gap-2 rounded-[16px]" style={{ background: '#EFFBEF', padding: '12px 14px', border: '1px solid #D5EED9' }}>
            <Check className="w-4 h-4 shrink-0" style={{ color: '#27AE60' }} strokeWidth={2.6} />
            <p style={{ fontSize: '12px', color: '#5E5B8C', lineHeight: '18px' }}>
              <span style={{ color: '#27AE60', fontWeight: 700 }}>已处理冲突:</span> 已替换冲突节点，后续路线时间保持不变。
            </p>
          </div>
        )}
        <div className="mt-3 flex items-center gap-2 rounded-[16px]" style={{ background: '#F3F0FF', padding: '12px 14px' }}>
          <Sparkles className="w-4 h-4 shrink-0" style={{ color: '#6B63F6' }} strokeWidth={2.4} />
          <p style={{ fontSize: '12px', color: '#8A8FA8', lineHeight: '18px' }}>
            <span style={{ color: '#6B63F6', fontWeight: 700 }}>Agent</span> 会按时间节点分阶段触发,可随时回到结果页调整路线。
          </p>
        </div>
      </div>
    </div>
  );
}

function PlaceDetailPage({
  index,
  onBack,
  places,
  details,
}: {
  index: number;
  onBack: () => void;
  places: Array<UiPlace & { placeImg: string }>;
  details: UiPlaceDetail[];
}) {
  const place = places[index];
  const detail = details[index];
  const isInvalid = !place || !detail;

  if (isInvalid) {
    return (
      <div className="flex flex-col h-full bg-[#F7F8FC]">
        <header
          className="px-5 pb-3 flex items-center shrink-0 bg-[#F7F8FC]"
          style={{ paddingTop: 'max(44px, env(safe-area-inset-top))' }}
        >
          <button onClick={onBack} className="w-8 h-8 flex items-center justify-center text-[#1A1A2E] mr-2">
            <ChevronLeft className="w-6 h-6 stroke-[2.5]" />
          </button>
          <h1 className="font-bold text-[18px] tracking-wide" style={{ color: '#6B63F6' }}>
            地点详情
          </h1>
        </header>
        <div className="flex-1 flex items-center justify-center px-6">
          <p style={{ fontSize: '14px', color: '#6B6F86' }}>该地点数据不可用，请返回路线页重试。</p>
        </div>
      </div>
    );
  }

  const infoRows = [
    { label: '地点类型', value: detail.detail_place_type },
    { label: '距离', value: detail.detail_distance },
    { label: '预计到达', value: detail.detail_duration },
    { label: '排队情况', value: detail.detail_queue_status },
    { label: '营业状态', value: detail.detail_open_status },
  ];

  return (
    <div className="flex flex-col h-full bg-[#F7F8FC]">
      <header
        className="px-5 pb-3 flex items-center shrink-0 bg-[#F7F8FC]"
        style={{ paddingTop: 'max(44px, env(safe-area-inset-top))' }}
      >
        <button onClick={onBack} className="w-8 h-8 flex items-center justify-center text-[#1A1A2E] mr-2">
          <ChevronLeft className="w-6 h-6 stroke-[2.5]" />
        </button>
        <h1 className="font-bold text-[18px] tracking-wide" style={{ color: '#6B63F6' }}>
          {detail.detail_title}
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-[100px]" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        <div className="overflow-hidden mb-5" style={{ width: '100%', height: '190px', borderRadius: '22px' }}>
          <img
            src={place.placeImg}
            alt={place.place_title}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </div>

        <div className="bg-white rounded-[22px] border border-[#E8E4FF] shadow-[0_4px_20px_rgba(123,110,246,0.06)] p-5 mb-4">
          <h2 className="mb-1" style={{ fontSize: '18px', fontWeight: 800, color: '#5E5B8C' }}>
            {detail.detail_place_name}
          </h2>

          <p className="mb-4" style={{ fontSize: '13px', lineHeight: '20px', color: '#5E627A' }}>
            {detail.detail_recommend_reason}
          </p>

          <div className="w-full border-t border-dashed border-[#E8E4FF] mb-4" />

          <div className="space-y-3">
            {infoRows.map(row => (
              <div key={row.label} className="flex items-center justify-between">
                <span style={{ fontSize: '12.5px', color: '#8B82C0', fontWeight: 600 }}>{row.label}</span>
                <span style={{ fontSize: '13px', color: '#5E5B8C', fontWeight: 700 }}>{row.value}</span>
              </div>
            ))}
          </div>

          <div className="w-full border-t border-dashed border-[#E8E4FF] mt-4 mb-4" />

          <div className="flex flex-wrap gap-2">
            {detail.detail_tags.map((tag, ti) => (
              <span
                key={ti}
                className="rounded-full bg-[#F4F1FF]"
                style={{ fontSize: '11px', color: '#6B63F6', padding: '4px 12px', fontWeight: 600 }}
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div
        className="px-5 flex gap-3 bg-[#F7F8FC] shrink-0"
        style={{ paddingBottom: 'max(28px, env(safe-area-inset-bottom))', paddingTop: '12px', borderTop: '1px solid #EEE9FF' }}
      >
        <button
          onClick={() => toast('加入路线功能开发中', { duration: 1500 })}
          className="flex-1 rounded-[16px] bg-gradient-to-r from-[#7B6EF6] to-[#5B8AF0] text-white shadow-[0_6px_16px_rgba(107,99,246,0.30)] hover:scale-[1.02] active:scale-[0.98] transition-transform"
          style={{ height: '52px', fontSize: '15px', fontWeight: 700 }}
        >
          加入路线
        </button>
        <button
          onClick={() => toast('替换功能开发中', { duration: 1500 })}
          className="flex-1 rounded-[16px] bg-white border-2 border-[#D8D3FF] text-[#6B63F6] hover:bg-[#F2EFFF] hover:border-[#6B63F6] active:scale-[0.98] transition-all"
          style={{ height: '52px', fontSize: '15px', fontWeight: 700 }}
        >
          替换这个点
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [currentView, setCurrentView] = useState<'intro' | 'setup' | 'chat' | 'result' | 'detail' | 'agent-processing' | 'agent-execution' | 'voucher' | 'conflict-detected' | 'conflict-resolve' | 'agent-execution-updated' | 'mission-complete' | 'success-completion'>('intro');
  const [detailIndex, setDetailIndex] = useState<number>(0);
  const [voucherIndex, setVoucherIndex] = useState<number>(0);
  const [orderLoading, setOrderLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [clarifyTopic, setClarifyTopic] = useState<'location' | 'time' | null>(null);
  const [clarifyQuestion, setClarifyQuestion] = useState('');
  const [clarifyInput, setClarifyInput] = useState('');
  const [clarifyLoading, setClarifyLoading] = useState(false);
  // 多轮澄清的历史记录(每条 = 后端问的一个问题 + 用户的回答),
  // 渲染在主状态气泡之前,保证顺序: 旧 Q -> 旧 A -> 新状态气泡,
  // 避免出现"正在确认位置"气泡跑到用户回答上方的诡异顺序。
  const [clarifyHistory, setClarifyHistory] = useState<Array<{question: string; answer: string}>>([]);
  const [processingTasks, setProcessingTasks] = useState<string[]>(PROCESSING_TASKS);
  const [conflictSolutions, setConflictSolutions] = useState(DEFAULT_CONFLICT_SOLUTIONS);
  const [conflictReason, setConflictReason] = useState('轻食补给暂时无法完成排号');
  // 一键下单后总会进入预检页：true=有冲突(显示解决方案), false=无冲突(显示绿勾+开始副本)
  const [hasConflict, setHasConflict] = useState(false);
  // 接管页的阶段：running=思考中, conflict=检测到冲突, ok=预检通过。
  // 三个阶段都在同一个页面内就地切换,不再跳转新页面。
  const [processingPhase, setProcessingPhase] = useState<'running' | 'conflict' | 'ok'>('running');
  const [apiError, setApiError] = useState<string | null>(null);
  const [places, setPlaces] = useState<Array<UiPlace & { placeImg: string; iconComponent: any }>>([]);
  const [segments, setSegments] = useState<UiSegment[]>([]);
  const [placeDetails, setPlaceDetails] = useState<UiPlaceDetail[]>([]);
  const [executionTasks, setExecutionTasks] = useState<Array<UiExecutionTask & { image: string; statusColor: string }>>([]);
  const [routeTitle, setRouteTitle] = useState('【已生成专属路线】');
  const [routeErrors, setRouteErrors] = useState<string[]>([]);
  const [routeLocationLabel, setRouteLocationLabel] = useState('');
  const [routeDataSource, setRouteDataSource] = useState('');
  const [originCoord, setOriginCoord] = useState('');
  // 副本通关页数据:核销最后一站时根据真实行程一次性生成并冻结
  const [completionData, setCompletionData] = useState<CompletionData | null>(null);

  // ---- 定位功能 ----
  const DEFAULT_LOC = { city: '上海', district: '浦东新区' };
  // 本次会话已解析出的定位(缓存,避免每次生成都重新弹定位)
  const resolvedLocRef = useRef<{ city: string; district: string } | null>(null);
  const [locModalOpen, setLocModalOpen] = useState(false);
  const [locModalCity, setLocModalCity] = useState('上海');
  const [locModalDistrict, setLocModalDistrict] = useState('');
  // 手动输入弹窗的 promise resolver
  const locModalResolveRef = useRef<((v: { city: string; district: string }) => void) | null>(null);

  // 调浏览器原生定位拿经纬度(10s 超时)。失败时 reject 一个可读原因。
  const getBrowserCoords = (): Promise<{ lng: number; lat: number }> =>
    new Promise((resolve, reject) => {
      // 非安全上下文(非 https / 非 localhost)浏览器直接禁用定位,不会弹窗
      if (!window.isSecureContext) {
        reject(new Error('当前不是 HTTPS/localhost，浏览器禁用了定位'));
        return;
      }
      if (!('geolocation' in navigator)) {
        reject(new Error('此浏览器不支持定位'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lng: pos.coords.longitude, lat: pos.coords.latitude }),
        (err) => {
          const reason =
            err.code === err.PERMISSION_DENIED
              ? '定位权限被拒绝(可能此前点过拒绝，或系统定位已关)'
              : err.code === err.POSITION_UNAVAILABLE
                ? '系统定位服务不可用(检查 macOS 定位服务是否开启)'
                : err.code === err.TIMEOUT
                  ? '定位超时'
                  : '定位失败';
          reject(new Error(reason));
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
      );
    });

  // 打开手动输入弹窗,返回用户填写的城市/区
  const askManualLocation = (): Promise<{ city: string; district: string }> =>
    new Promise((resolve) => {
      locModalResolveRef.current = resolve;
      setLocModalCity('上海');
      setLocModalDistrict('');
      setLocModalOpen(true);
    });

  // 确保拿到定位：缓存 → 浏览器定位+逆地理编码 → 失败则手动输入
  const ensureLocation = async (): Promise<{ city: string; district: string }> => {
    if (resolvedLocRef.current) return resolvedLocRef.current;
    try {
      const { lng, lat } = await getBrowserCoords();
      const res = await locateByCoords(lng, lat);
      if (res.ok && res.city) {
        const loc = { city: res.city, district: res.district || '' };
        resolvedLocRef.current = loc;
        toast(`已定位到 ${loc.city}${loc.district}`, { duration: 1500 });
        return loc;
      }
      // 把后端透出的真实原因(如 regeo_api_error:INVALID_USER_KEY)显示出来,便于排查
      const why = res.error ? `（${res.error}）` : '';
      toast(`坐标解析失败${why}，请手动填写`, { duration: 3000 });
    } catch (err) {
      // 用户拒绝授权 / 超时 / 无定位能力 → 提示原因并走手动输入
      const reason = err instanceof Error ? err.message : '定位失败';
      toast(`${reason}，请手动填写`, { duration: 2600 });
    }
    const manual = await askManualLocation();
    const loc = { city: manual.city || DEFAULT_LOC.city, district: manual.district };
    resolvedLocRef.current = loc;
    return loc;
  };

  // 根据真实行程(用户选择 + 后端规划)生成副本通关页数据,替换原 Figma 假数据。
  const buildCompletionData = (): CompletionData => {
    const { type: dungeonType, tag: dungeonTag } = dungeonProfile(purpose, people);
    // 副本名按「目的 + 氛围」生成简短主题名,不再使用后端的长行程串。
    const routeName = dungeonRouteName(purpose, mood);

    const spotsCount = places.length;
    const totalMeters = segments.reduce((sum, s) => sum + parseDistanceMeters(s.distance), 0);
    const walk =
      totalMeters >= 1000 ? `${(totalMeters / 1000).toFixed(1)} km` : `${Math.round(totalMeters)} 米`;
    const hours = computeDurationHours(places.map((p) => p.time_slot));
    const duration = hours > 0 ? `${hours.toFixed(1)} 小时` : '—';
    const kcal = Math.round((totalMeters / 1000) * 65);
    const calories = kcal > 0 ? `${kcal} kcal` : '—';

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const completedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const ticketNo =
      'DK' +
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const coverImg = places[0]?.image_url || places[0]?.placeImg || PLACE_IMG_1;

    const ticketRows = [
      { label: '玩家', value: '玩家本人' },
      { label: '副本类型', value: dungeonType },
      { label: '出行人数', value: people || '—' },
      { label: '氛围偏好', value: mood || '—' },
      { label: '出发地点', value: routeLocationLabel || '—' },
      { label: '打卡地点', value: `${spotsCount} 个` },
      { label: '完成时间', value: completedAt },
      { label: '备注', value: '虚拟打卡纪念海报，仅供分享，不作发票或报销凭证' },
    ];

    return {
      routeName,
      dungeonType,
      dungeonTag,
      coverImg,
      completedAt,
      ticketNo,
      stats: { duration, walk, spots: `${spotsCount} 个`, calories },
      ticketRows,
    };
  };

  // 核销码核销：
  // - 核销最后一站 → 副本通关
  // - 核销倒数第二站 → 自动为最后一站(待定)取号排队,回到任务列表
  // - 其他中间节点 → 标记已核销,回到任务列表
  const handleVoucherVerify = () => {
    const tasks = [...executionTasks];
    const lastIdx = tasks.length - 1;
    const idx = voucherIndex;

    if (tasks[idx]) {
      tasks[idx] = {
        ...tasks[idx],
        status: 'verified',
        statusLabel: '已核销',
        statusColor: '#27AE60',
        voucherDim: true,
      };
    }

    if (idx >= lastIdx) {
      setExecutionTasks(tasks);
      setCompletionData(buildCompletionData());
      setCurrentView('mission-complete');
      return;
    }

    if (idx === lastIdx - 1 && tasks[lastIdx]) {
      const last = tasks[lastIdx];
      const isPending =
        last.status === 'arranged' || last.statusLabel === '待定' || last.voucherDim;
      if (isPending) {
        const queueId = 'Q' + Math.floor(1000 + Math.random() * 9000);
        const waitMin = 10 + Math.floor(Math.random() * 20);
        tasks[lastIdx] = {
          ...last,
          status: 'fallback',
          statusLabel: '排队中·已取号',
          statusColor: '#F2994A',
          voucherDim: false,
          description: `已自动取号 ${queueId}，预计等位 ${waitMin} 分钟，到号自动提醒（刚核销上一站，已为你提前排队，避免过号）`,
        };
        setExecutionTasks(tasks);
        toast(`已为最后一站「${last.place}」自动取号，排队中`, { duration: 2200 });
        setCurrentView('agent-execution');
        return;
      }
    }

    setExecutionTasks(tasks);
    setCurrentView('agent-execution');
  };

  const handleOrderClick = async () => {
    if (orderLoading) return;
    if (!sessionId) {
      toast('请先生成路线', { duration: 1200 });
      return;
    }
    setOrderLoading(true);
    setProcessingPhase('running');
    setCurrentView('agent-processing');
    setProcessingTasks(['正在提交执行请求...', '正在等待执行结果...']);
    // 记录开始时间：保证"小袋鼠正在接管"思考动画至少完整展示一段时间,
    // 即使后端秒回,用户也能看到 Agent 在帮忙下单/排号,而不是一闪而过。
    const orderStart = Date.now();
    const MIN_PROCESSING_MS = 1800;
    const goAfterMinDwell = (fn: () => void) => {
      const wait = Math.max(0, MIN_PROCESSING_MS - (Date.now() - orderStart));
      window.setTimeout(fn, wait);
    };
    const actionDetails: string[] = [];
    const nextTasks = [...executionTasks];
    try {
      await executePlan({ session_id: sessionId }, (evt) => {
        if (isSseEvent(evt, 'action_progress')) {
          const payload = evt.data;
          actionDetails.push(String(payload.detail || '执行中...'));
          setProcessingTasks([...actionDetails]);
          const idx = Number(payload.index || 0);
          if (nextTasks[idx]) {
            const nextStatus = String(payload.status || nextTasks[idx].status);
            nextTasks[idx] = {
              ...nextTasks[idx],
              status: nextStatus,
              statusLabel: taskStatusLabel(nextTasks[idx].actionType, nextStatus),
              statusColor: statusColorByStatus(nextStatus),
              description: String(payload.detail || nextTasks[idx].description),
            };
            setExecutionTasks([...nextTasks]);
          }
        }
        if (isSseEvent(evt, 'conflict')) {
          setConflictReason(String(evt.data.reason || ''));
          setConflictSolutions(buildConflictSolutions(evt.data as any));
          // 就地在接管页切换到"冲突"阶段,不跳新页面
          goAfterMinDwell(() => {
            setHasConflict(true);
            setProcessingPhase('conflict');
          });
        }
        if (isSseEvent(evt, 'done')) {
          // 就地在接管页切换到"预检通过"阶段,不跳新页面
          goAfterMinDwell(() => {
            setHasConflict(false);
            setProcessingPhase('ok');
          });
        }
        if (isSseEvent(evt, 'error')) {
          const message = String(evt.data.message || '执行失败');
          setApiError(message);
          toast(message, { duration: 1800 });
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '执行失败';
      setApiError(message);
      toast(message, { duration: 1800 });
    } finally {
      setOrderLoading(false);
    }
  };

  const [purpose, setPurpose] = useState<string | null>(null);
  const [people, setPeople] = useState<string | null>(null);
  const [mood, setMood] = useState<string | null>(null);
  const [userText, setUserText] = useState('');

  const [agentReplyPhase, setAgentReplyPhase] = useState<'idle' | 'thinking' | 'generating'>('idle');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [showProgress, setShowProgress] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [userBubbleText, setUserBubbleText] = useState('');

  const typingTimerRef = useRef<number | null>(null);
  const thinkingTimerRef = useRef<number | null>(null);
  const generationIdRef = useRef(0);
  // 聊天消息底部锚点：新消息/新气泡出现时自动滚到底,避免被遮挡
  const chatBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (currentView !== 'chat') return;
    // 等 DOM 更新完这一帧再滚，否则会按旧高度滚动，最新气泡仍被输入框遮住
    const id = requestAnimationFrame(() => {
      chatBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
    return () => cancelAnimationFrame(id);
  }, [
    currentView,
    agentReplyPhase,
    clarifyTopic,
    clarifyQuestion,
    clarifyHistory.length,
    userBubbleText,
    streamingText,
    isGenerating,
  ]);

  const clearAllTimers = () => {
    if (typingTimerRef.current !== null) {
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    if (thinkingTimerRef.current !== null) {
      clearTimeout(thinkingTimerRef.current);
      thinkingTimerRef.current = null;
    }
  };

  // 进度条「丝滑慢爬」:从 0 均匀爬到 95,每 ~140ms +1%,总耗时 ~13s,
  // 与开了百炼 LLM 后的真实端到端时长(10-15s)基本同步;
  // 后端 plan_ready/done 时 setProgress(100) 直接收尾,不会卡顿。
  // 阶段事件不再强行把进度跳到 30/55/80 那种刻度——避免"跳一下又卡住"的观感。
  useEffect(() => {
    if (!showProgress || !isGenerating) return;
    const timer = window.setInterval(() => {
      setProgress((p) => {
        if (p < 95) return Math.min(95, p + 1);
        return p;
      });
    }, 140);
    return () => window.clearInterval(timer);
  }, [showProgress, isGenerating]);

  const handleSelect = (questionId: string, option: string) => {
    if (questionId === 'purpose') {
      setPurpose(option);
      // 选「独自放空」时人数恒为 1 人——逻辑上独处就只有自己,无需再问。
      // 选其他目的(如自习办公)时不强锁,允许后续手动改人数。
      if (option === '独自放空') {
        setPeople('1人');
      } else if (people === '1人' && purpose === '独自放空') {
        // 从「独自放空」切到其他目的时,把之前自动锁的 1 人清掉让用户重新选
        setPeople(null);
      }
    }
    if (questionId === 'people') {
      // 「独自放空」状态下人数只能是 1 人,屏蔽其他点击
      if (purpose === '独自放空' && option !== '1人') return;
      setPeople(option);
    }
    if (questionId === 'vibe') setMood(option);
  };

  const isAllSelected = purpose !== null && people !== null && mood !== null;

  const runTypewriter = (fullText: string, genId: number) => {
    return new Promise<void>((resolve) => {
      setIsStreaming(true);
      setStreamingText('');
      let i = 0;
      const step = () => {
        if (generationIdRef.current !== genId) {
          resolve();
          return;
        }
        if (i >= fullText.length) {
          setIsStreaming(false);
          typingTimerRef.current = null;
          resolve();
          return;
        }
        i++;
        setStreamingText(fullText.slice(0, i));
        typingTimerRef.current = window.setTimeout(step, 40 + Math.random() * 30);
      };
      step();
    });
  };

  const iconComponentByName = (name: UiPlace['icon']) => {
    if (name === 'Flag') return Flag;
    if (name === 'Sparkles') return Sparkles;
    if (name === 'IceCreamCone') return IceCreamCone;
    return MapPin;
  };

  const imageByIndex = (_idx: number) => PLACE_IMG_FALLBACK;

  const applyPlanState = (planState: any) => {
    const ui = adaptPlanState(planState);
    const mappedPlaces = ui.places.map((p, idx) => ({
      ...p,
      placeImg: p.image_url || imageByIndex(idx),
      iconComponent: iconComponentByName(p.icon),
    }));
    const executionSource = ui.executionTasks.length ? ui.executionTasks : [];
    const mappedTasks = executionSource.map((t, idx) => ({
      ...t,
      image: t.image_url || imageByIndex(idx),
      statusColor: statusColorByStatus(t.status),
    }));
    setPlaces(mappedPlaces);
    setSegments(ui.segments);
    setPlaceDetails(ui.details);
    setExecutionTasks(mappedTasks);
    const firstTitle = mappedPlaces[0]?.place_title || '';
    setRouteTitle(ui.routeSummary ? `【${ui.routeSummary}】` : firstTitle ? `【${firstTitle}】` : '【已生成专属路线】');
    setRouteErrors(Array.isArray(ui.errors) ? ui.errors.map(String) : []);
    setRouteLocationLabel(String(ui.locationLabel || ''));
    setRouteDataSource(String(ui.dataSource || ''));
    setOriginCoord(String(ui.origin || ''));
  };

  const buildGoalText = (payload: GeneratePlanPayload) => {
    const chips = [payload.purpose, payload.people, payload.mood].filter(Boolean).join(' · ');
    if (payload.userText.trim()) return payload.userText.trim();
    return chips || '今天下午帮我规划一个周末副本';
  };

  const handlePlanEvents = (evt: SseEnvelope) => {
    if (isSseEvent(evt, 'progress')) {
      const payload = evt.data;
      setShowProgress(true);
      setProgress((p) => Math.max(p, Math.max(0, Math.min(100, Number(payload.percent || 0)))));
    }
    if (isSseEvent(evt, 'agent_step')) {
      setAgentReplyPhase('generating');
      setShowProgress(true);
      const payload = evt.data;
      const stageMap: Record<string, string> = {
        intent: '解析意图',
        location: '确认位置',
        planner: '生成路线',
        executor: '生成执行动作',
      };
      // 阶段事件只更新文案(让用户知道当前在做什么),进度条由时间驱动的 useEffect 平滑推进。
      // 不再把进度跳到 30/55/80 这种刻度——避免"跳一下卡住"的破碎感,体验更丝滑。
      const stageKey = String(payload.stage || '');
      const stage = stageMap[stageKey] || '处理中';
      setStreamingText(`正在${stage}...`);
    }
    if (isSseEvent(evt, 'needs_clarification')) {
      const payload = evt.data;
      setSessionId(String(payload.session_id || sessionId || ''));
      setClarifyTopic((payload.topic as 'location' | 'time') || 'location');
      setClarifyQuestion(String(payload.question || '请补充信息'));
      setAgentReplyPhase('idle');
      setIsGenerating(false);
      setShowProgress(false);
      setProgress(0);
    }
    if (isSseEvent(evt, 'plan_ready')) {
      const payload = evt.data;
      setSessionId(String(payload.session_id || sessionId || ''));
      applyPlanState(payload.plan_state || {});
      setProcessingTasks(PROCESSING_TASKS);
      setClarifyTopic(null);
      setClarifyQuestion('');
      setCurrentView('result');
      setIsGenerating(false);
      setShowProgress(false);
      setProgress(0);
      setAgentReplyPhase('idle');
    }
    if (isSseEvent(evt, 'error')) {
      const message = String(evt.data.message || '请求失败');
      setApiError(message);
      setIsGenerating(false);
      toast(message, { duration: 1800 });
    }
    if (isSseEvent(evt, 'conflict')) {
      const payload = evt.data;
      if (payload.session_id) {
        setSessionId(String(payload.session_id));
      }
      setHasConflict(true);
      setConflictReason(String(payload.reason || ''));
      setConflictSolutions(buildConflictSolutions(evt.data as any));
      setCurrentView('conflict-detected');
      setIsGenerating(false);
    }
    if (isSseEvent(evt, 'done')) {
      setIsGenerating(false);
      setShowProgress(false);
      setProgress(0);
      setAgentReplyPhase('idle');
    }
  };

  const startGeneration = async (payload: GeneratePlanPayload) => {
    clearAllTimers();
    const genId = ++generationIdRef.current;

    setIsGenerating(true);
    setStreamingText('');
    setProgress(0);
    setShowProgress(false);

    setAgentReplyPhase('thinking');
    await new Promise<void>((resolve) => {
      thinkingTimerRef.current = window.setTimeout(() => {
        thinkingTimerRef.current = null;
        resolve();
      }, 1300);
    });
    if (generationIdRef.current !== genId) return;

    setAgentReplyPhase('generating');
    await runTypewriter('正在连接规划引擎...', genId);
    if (generationIdRef.current !== genId) return;

    // 真实定位：浏览器定位→逆地理编码;失败则让用户手动输入城市/区
    const loc = await ensureLocation();
    if (generationIdRef.current !== genId) return;

    try {
      await startPlan(
        {
          goal: buildGoalText(payload),
          city: loc.city,
          district: loc.district,
        },
        handlePlanEvents,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成失败';
      setApiError(message);
      setIsGenerating(false);
      toast(message, { duration: 1800 });
    }
  };

  const handleSendClick = () => {
    if (isGenerating) return;

    const trimmedText = userText.trim();

    // 正在反问(追问)时:主输入框的内容作为本轮补充答案提交,不再开新一轮规划。
    if (clarifyTopic) {
      if (!trimmedText) {
        toast('请在输入框补充信息(如:上海浦东 / 下午2点开始4小时)', { duration: 1800 });
        return;
      }
      setUserBubbleText(trimmedText);
      setUserText('');
      handleClarifySubmit(trimmedText);
      return;
    }

    if (trimmedText.length > 0) {
      const payload: GeneratePlanPayload = { purpose, people, mood, userText: trimmedText, source: 'text' };
      setUserBubbleText(trimmedText);
      setUserText('');
      window.setTimeout(() => startGeneration(payload), 300);
      return;
    }

    if (isAllSelected) {
      const summary = [purpose, people, mood].join(' · ');
      const payload: GeneratePlanPayload = { purpose, people, mood, userText: '', source: 'chips' };
      setUserBubbleText(summary);
      window.setTimeout(() => startGeneration(payload), 300);
      return;
    }

    toast('先选完3个问题，或者直接说出你的需求哦', { duration: 1500 });
  };

  const resetChatState = () => {
    clearAllTimers();
    generationIdRef.current++;
    setPurpose(null);
    setPeople(null);
    setMood(null);
    setUserText('');
    setUserBubbleText('');
    setAgentReplyPhase('idle');
    setIsStreaming(false);
    setStreamingText('');
    setShowProgress(false);
    setProgress(0);
    setIsGenerating(false);
    setSessionId(null);
    setClarifyTopic(null);
    setClarifyQuestion('');
    setClarifyInput('');
    setClarifyLoading(false);
    setClarifyHistory([]);
    setApiError(null);
    setProcessingTasks(PROCESSING_TASKS);
    setConflictSolutions(DEFAULT_CONFLICT_SOLUTIONS);
    setConflictReason('');
    setHasConflict(false);
    setProcessingPhase('running');
    resolvedLocRef.current = null;
    setPlaces([]);
    setSegments([]);
    setPlaceDetails([]);
    setExecutionTasks([]);
    setRouteTitle('【已生成专属路线】');
    setRouteErrors([]);
    setRouteLocationLabel('');
    setRouteDataSource('');
    setOriginCoord('');
  };

  const handleBackToIntro = () => {
    resetChatState();
    setCurrentView('intro');
  };

  const handleReset = () => {
    resetChatState();
    setCurrentView('chat');
  };

  const handlePlaceClick = (index: number) => {
    setDetailIndex(index);
    setCurrentView('detail');
  };

  const handleClarifySubmit = async (rawAnswer?: string) => {
    // 反问的回答统一从主输入框传入(rawAnswer);兼容旧调用时回退到 clarifyInput。
    const answer = (rawAnswer ?? clarifyInput).trim();
    if (!sessionId || !clarifyTopic || !answer) return;
    setClarifyLoading(true);
    // 提交瞬间就把这一轮 Q+A 沉到 clarifyHistory,
    // 同时清掉当前 ClarifyView,这样下一波 agent_step 来时,
    // 新状态气泡会渲染在历史 Q+A 的下面,顺序正确。
    const question = clarifyQuestion;
    setClarifyHistory((prev) => [...prev, { question, answer }]);
    setClarifyTopic(null);
    setClarifyQuestion('');
    setClarifyInput('');
    // 立刻进入 thinking 态显示新气泡,避免空窗
    setAgentReplyPhase('thinking');
    setIsGenerating(true);
    try {
      await clarifyPlan(
        { session_id: sessionId, topic: clarifyTopic, answer },
        handlePlanEvents,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '澄清提交失败';
      setApiError(message);
      setAgentReplyPhase('idle');
      setIsGenerating(false);
      toast(message, { duration: 1800 });
    } finally {
      setClarifyLoading(false);
    }
  };

  // 24 个方块(原本12个,每块8.3%太粗,看起来卡):
  // 加细到24个后每块4.17%,配合时间驱动的1%/140ms慢爬,视觉上几乎每0.6s亮一格,丝滑很多。
  const progressBlocks = 24;
  const filledBlocks = Math.floor((progress / 100) * progressBlocks);

  const submitManualLocation = () => {
    const city = locModalCity.trim() || DEFAULT_LOC.city;
    const district = locModalDistrict.trim();
    setLocModalOpen(false);
    locModalResolveRef.current?.({ city, district });
    locModalResolveRef.current = null;
  };

  return (
    <>
      <Toaster position="top-center" />
      {locModalOpen && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center px-8"
          style={{ background: 'rgba(20,18,40,0.45)' }}
        >
          <div className="w-full bg-white rounded-[24px] p-6 shadow-[0_12px_40px_rgba(0,0,0,0.18)]" style={{ maxWidth: '340px' }}>
            <h2 style={{ fontSize: '19px', fontWeight: 800, color: '#282447' }}>填写你的位置</h2>
            <p className="mt-1.5" style={{ fontSize: '13px', color: '#6B6F86', lineHeight: '19px' }}>
              没拿到定位授权,手动填一下当前城市和区,小袋鼠按这个规划。
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label style={{ fontSize: '12px', fontWeight: 700, color: '#6B63F6' }}>城市</label>
                <input
                  value={locModalCity}
                  onChange={(e) => setLocModalCity(e.target.value)}
                  placeholder="如：上海"
                  className="mt-1 w-full rounded-[12px] border px-3 outline-none"
                  style={{ height: '44px', borderColor: '#D8D3FF', fontSize: '14px' }}
                />
              </div>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 700, color: '#6B63F6' }}>区 / 县（可选）</label>
                <input
                  value={locModalDistrict}
                  onChange={(e) => setLocModalDistrict(e.target.value)}
                  placeholder="如：浦东新区"
                  className="mt-1 w-full rounded-[12px] border px-3 outline-none"
                  style={{ height: '44px', borderColor: '#D8D3FF', fontSize: '14px' }}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitManualLocation(); }}
                />
              </div>
            </div>
            <button
              onClick={submitManualLocation}
              className="mt-5 w-full rounded-[14px] text-white active:scale-[0.98] transition-transform"
              style={{ height: '48px', fontSize: '15px', fontWeight: 700, background: 'linear-gradient(to right, #7B6EF6, #5B8AF0)' }}
            >
              确认
            </button>
          </div>
        </div>
      )}
      <div className="w-full bg-[#F7F8FC] font-sans relative overflow-hidden" style={{ minHeight: '100dvh' }}>
        <img
          src={BG_IMAGE}
          alt=""
          className="absolute inset-0 w-full h-full pointer-events-none z-0"
          style={{ objectFit: 'cover', objectPosition: 'center bottom' }}
        />

        <AnimatePresence mode="wait">
          {currentView === 'intro' && (
            <motion.div
              key="intro"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
              className="absolute inset-0 z-50 flex items-center justify-center bg-[#F7F8FC]"
            >
              <IntroScreen onStart={() => setCurrentView('chat')} />
            </motion.div>
          )}

          {currentView === 'setup' && (
            <motion.div
              key="setup"
              className="absolute inset-0 flex flex-col z-10 h-full bg-[#F7F8FC]"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -50 }}
              transition={{ duration: 0.3 }}
            >
              <PlanSetupView
                onPlanReady={(planState, sid) => {
                  applyPlanState(planState as any);
                  setSessionId(sid);
                  setCurrentView('result');
                }}
                onBack={() => {
                  resetChatState();
                  setCurrentView('intro');
                }}
              />
            </motion.div>
          )}

          {currentView === 'chat' && (
            <motion.div
              key="chat"
              className="absolute inset-0 flex flex-col z-10 h-full"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -50 }}
              transition={{ duration: 0.3 }}
            >
              <header className="px-5 pb-2 flex items-start justify-between z-20 shrink-0" style={{ paddingTop: 'max(44px, env(safe-area-inset-top))' }}>
                <div className="flex items-start gap-3">
                  <button onClick={handleBackToIntro} className="mt-1 flex items-center justify-center text-[#1A1A2E]">
                    <ChevronLeft className="w-6 h-6 stroke-[2.5]" />
                  </button>
                  <div className="flex flex-col">
                    <div className="flex items-center gap-[7px]">
                      <Globe className="w-[22px] h-[22px] text-[#6B63F6] stroke-[2.5] shrink-0" />
                      <h1 className="leading-none flex items-baseline gap-[2px]">
                        <span
                          style={{
                            fontWeight: 900,
                            fontSize: '22px',
                            background: 'linear-gradient(135deg, #7B6EF6 0%, #5B8AF0 100%)',
                            WebkitBackgroundClip: 'text',
                            backgroundClip: 'text',
                            color: 'transparent',
                          }}
                        >地球</span>
                        <span
                          style={{
                            fontFamily: '"Press Start 2P", monospace',
                            fontSize: '13px',
                            background: 'linear-gradient(135deg, #7B6EF6 0%, #5B8AF0 100%)',
                            WebkitBackgroundClip: 'text',
                            backgroundClip: 'text',
                            color: 'transparent',
                            letterSpacing: '0.5px',
                          }}
                        >Online</span>
                      </h1>
                    </div>
                    <div className="flex items-center mt-[5px]" style={{ marginLeft: '29px' }}>
                      <span
                        className="text-[#8B82F0] whitespace-nowrap"
                        style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '1.4px', opacity: 0.88 }}
                      >
                        周末副本 · 组队中...
                      </span>
                      <span className="inline-block w-[3px] h-[13px] rounded-[2px] bg-[#7B6EF6] ml-[3px] animate-pulse" />
                    </div>
                  </div>
                </div>
              </header>

              <div
                className="flex-1 overflow-y-auto px-6 pb-2 z-20 relative"
                style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
              >
                <style dangerouslySetInnerHTML={{__html: `::-webkit-scrollbar { display: none; }`}} />

                <div className="flex items-start gap-[16px] mt-5 -mx-2">
                  <div className="shrink-0 mt-[6px]">
                    <img src={AGENT_AVATAR} alt="小团" className="w-[50px] h-[50px] object-contain" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="bg-white rounded-[20px] rounded-tl-sm p-4 shadow-[0_4px_15px_rgba(0,0,0,0.03)] border border-[#E2E4FA]">
                      <p className="text-[13px] font-medium text-[#8B82F0] mb-2">我是你的专属向导，小团。</p>
                      <h2 className="text-[16px] font-bold text-[#5E5B8C] mb-1 tracking-wide">🎮 副本启动！</h2>
                      <p className="text-[13px] mb-4 font-medium" style={{ color: '#5E627A' }}>快问你 3 个问题锁定方案：</p>

                      <div className="w-full border-t border-dashed border-[#D8D3FF] mb-3" />

                      <div className="space-y-[14px]">
                        {QUESTIONS.map((q) => {
                          const currentValue = q.id === 'purpose' ? purpose : q.id === 'people' ? people : mood;
                          return (
                            <div key={q.id} className="space-y-2.5">
                              <h3 className="text-[14px] font-bold text-[#5E5B8C]">
                                {q.title}
                              </h3>
                              <div className="grid grid-cols-4 gap-1.5">
                                {q.options.map(opt => {
                                  const isSelected = currentValue === opt;
                                  // 「独自放空」时人数题只允许 1 人,其他选项视觉上禁用
                                  const lockedByPurpose =
                                    q.id === 'people' && purpose === '独自放空' && opt !== '1人';
                                  const isDisabled = isGenerating || lockedByPurpose;
                                  return (
                                    <button
                                      key={opt}
                                      onClick={() => handleSelect(q.id, opt)}
                                      disabled={isDisabled}
                                      title={lockedByPurpose ? '独自放空时人数固定为 1 人' : undefined}
                                      className={`
                                        px-1 py-[7px] rounded-[10px] text-[11px] font-bold transition-all duration-300 whitespace-nowrap
                                        ${isSelected
                                          ? 'bg-gradient-to-r from-[#7B6EF6] to-[#5B8AF0] text-white shadow-[0_4px_10px_rgba(107,99,246,0.3)] border-transparent'
                                          : 'bg-white border border-[#D8D3FF] text-[#1A1A2E] hover:border-[#6B63F6] hover:bg-[#F8F8FF] active:scale-95'
                                        }
                                        ${isDisabled && !isSelected ? 'opacity-40 cursor-not-allowed hover:border-[#D8D3FF] hover:bg-white' : ''}
                                        ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}
                                      `}
                                    >
                                      {opt}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>

                {userBubbleText && (
                  <div className="flex justify-end mt-[18px] px-1">
                    <div
                      className="max-w-[72%] px-[14px] py-[11px] rounded-[18px] rounded-br-[6px] text-[14px] leading-relaxed break-words"
                      style={{
                        background: 'linear-gradient(135deg, #E4DEFF 0%, #D6D0FF 100%)',
                        color: '#1A1A2E',
                        border: '1px solid rgba(123,110,246,0.28)',
                        boxShadow: '0 4px 14px rgba(123,110,246,0.14)',
                      }}
                    >
                      {userBubbleText}
                    </div>
                  </div>
                )}

                <style dangerouslySetInnerHTML={{ __html: `
                  @keyframes pixelThinking {
                    0%, 80%, 100% { opacity: 0.35; transform: translateY(0) scale(0.9); }
                    40% { opacity: 1; transform: translateY(-3px) scale(1); }
                  }
                  @keyframes replyFadeIn {
                    from { opacity: 0; transform: translateY(3px); }
                    to   { opacity: 1; transform: translateY(0); }
                  }
                `}} />

                {/* 已完成的多轮澄清: 后端问的 Q (左侧气泡) + 用户答的 A (右侧气泡) */}
                {clarifyHistory.map((item, idx) => (
                  <div key={`clarify-${idx}`}>
                    <div className="flex items-start gap-[16px] mt-[14px] -mx-2">
                      <div className="shrink-0 mt-[4px]">
                        <img src={AGENT_AVATAR} alt="小团" className="w-[50px] h-[50px] object-contain" />
                      </div>
                      <div className="flex-1 min-w-0 bg-white rounded-[20px] rounded-tl-[6px] shadow-[0_4px_15px_rgba(0,0,0,0.03)] border border-[#E2E4FA] p-4">
                        <p className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: '#5E5B8C' }}>
                          {item.question}
                        </p>
                      </div>
                    </div>
                    <div className="flex justify-end mt-[12px] px-1">
                      <div
                        className="max-w-[72%] px-[14px] py-[11px] rounded-[18px] rounded-br-[6px] text-[14px] leading-relaxed break-words"
                        style={{
                          background: 'linear-gradient(135deg, #E4DEFF 0%, #D6D0FF 100%)',
                          color: '#1A1A2E',
                          border: '1px solid rgba(123,110,246,0.28)',
                          boxShadow: '0 4px 14px rgba(123,110,246,0.14)',
                        }}
                      >
                        {item.answer}
                      </div>
                    </div>
                  </div>
                ))}

                {agentReplyPhase !== 'idle' && (
                  <div className="flex items-start gap-[16px] mt-[14px] -mx-2">
                    <div className="shrink-0 mt-[4px]">
                      <img src={AGENT_AVATAR} alt="小团" className="w-[50px] h-[50px] object-contain" />
                    </div>
                    <div className="flex-1 min-w-0 bg-white rounded-[20px] rounded-tl-[6px] shadow-[0_4px_15px_rgba(0,0,0,0.03)] border border-[#E2E4FA]">
                      {agentReplyPhase === 'thinking' && (
                        <div className="inline-flex items-center gap-[10px] px-[14px] py-[11px]" style={{ animation: 'replyFadeIn 220ms ease-out both' }}>
                          <span className="text-[13px]" style={{ fontWeight: 500, color: '#5E5B8C' }}>小团正在规划路线</span>
                          <span className="flex items-center gap-[4px]">
                            {[0, 0.15, 0.3].map((delay, i) => (
                              <span
                                key={i}
                                className="inline-block w-[6px] h-[6px] rounded-[2px]"
                                style={{
                                  background: 'linear-gradient(135deg, #7B6EF6 0%, #5B8AF0 100%)',
                                  animation: `pixelThinking 1s ${delay}s infinite ease-in-out`,
                                }}
                              />
                            ))}
                          </span>
                        </div>
                      )}

                      {agentReplyPhase === 'generating' && (
                        <div className="p-4" style={{ animation: 'replyFadeIn 220ms ease-out both' }}>
                          <p className="text-[13px] font-bold mb-3 tracking-wide min-h-[20px]" style={{ color: '#5E5B8C' }}>
                            {streamingText}
                            {isStreaming && <span className="inline-block w-[2px] h-[14px] bg-[#6B63F6] ml-[2px] animate-pulse" />}
                          </p>

                          {showProgress && (
                            <div className="flex items-center gap-2">
                              <div className="flex gap-[2px]">
                                {[...Array(progressBlocks)].map((_, idx) => (
                                  <div
                                    key={idx}
                                    className={`
                                      w-[6px] h-[10px] transition-all duration-200 rounded-[1px]
                                      ${idx < filledBlocks
                                        ? 'bg-[#6B63F6] shadow-[0_0_4px_rgba(107,99,246,0.4)]'
                                        : 'border-[1.5px] border-[#D8D3FF] bg-transparent'
                                      }
                                    `}
                                  />
                                ))}
                              </div>
                              <span className="text-[#6B63F6] text-[13px] font-black font-mono ml-1">{progress}%</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {clarifyTopic && clarifyQuestion && (
                  <div className="flex items-start gap-[16px] mt-[14px] -mx-2">
                    <div className="shrink-0 mt-[4px]">
                      <img src={AGENT_AVATAR} alt="小团" className="w-[50px] h-[50px] object-contain" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <ClarifyView question={clarifyQuestion} />
                    </div>
                  </div>
                )}

                {/* 锚点要高于输入框浮层(约110px),否则滚到底时最新气泡会落在输入框背后 */}
                <div ref={chatBottomRef} className="h-[130px] w-full" />
              </div>

              {/* 主输入框始终常驻,避免一会儿有一会儿没有。反问(追问)时也用它输入,提交即作为本轮补充答案。 */}
              <div className="absolute bottom-0 left-0 right-0 z-30 px-5 pt-4 bg-gradient-to-t from-[#F7F8FC] via-[#F7F8FC_80%] to-transparent" style={{ paddingBottom: 'max(34px, env(safe-area-inset-bottom))' }}>
                <div className="flex items-center gap-3 relative">
                  <div className="flex-1 bg-white rounded-[16px] h-[56px] flex items-center px-4 border border-[#D8D3FF] shadow-sm focus-within:border-[#6B63F6] transition-colors">
                    <input
                      type="text"
                      placeholder={clarifyTopic ? '在此补充(如:上海浦东 / 下午2点开始4小时)...' : '或者直接说也行...'}
                      value={userText}
                      onChange={(e) => setUserText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !isGenerating) {
                          handleSendClick();
                        }
                      }}
                      disabled={isGenerating}
                      className="w-full bg-transparent outline-none text-[14px] text-[#1A1A2E] placeholder-[#9FA3B8] font-medium disabled:opacity-50"
                    />
                  </div>
                  <button
                    onClick={handleSendClick}
                    disabled={isGenerating}
                    className={`
                      w-[56px] h-[56px] rounded-[16px] flex items-center justify-center transition-all duration-300 shrink-0
                      ${!isGenerating
                        ? 'bg-gradient-to-r from-[#7B6EF6] to-[#5B8AF0] text-white shadow-[0_4px_12px_rgba(107,99,246,0.4)] hover:scale-105 active:scale-95 cursor-pointer'
                        : 'bg-[#E2E4FA] text-white cursor-not-allowed opacity-60'
                      }
                    `}
                  >
                    <ArrowRight className="w-6 h-6 stroke-[2.5]" />
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {currentView === 'detail' && (
            <motion.div
              key={`detail-${detailIndex}`}
              className="absolute inset-0 flex flex-col z-50 bg-[#F7F8FC] h-full"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
            >
              <PlaceDetailPage
                index={detailIndex}
                places={places}
                details={placeDetails}
                onBack={() => setCurrentView('result')}
              />
            </motion.div>
          )}

          {currentView === 'result' && (
            <motion.div
              key="result"
              className="absolute inset-0 flex flex-col z-40 bg-[#F7F8FC] h-full"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            >
              <header className="px-5 pb-2 flex items-center sticky top-0 z-10 shrink-0 bg-[#F7F8FC]" style={{ paddingTop: 'max(44px, env(safe-area-inset-top))' }}>
                <button onClick={() => setCurrentView('chat')} className="w-8 h-8 flex items-center justify-center text-[#1A1A2E]">
                  <ChevronLeft className="w-6 h-6 stroke-[2.5]" />
                </button>
                <h1 className="font-bold text-[18px] ml-2 tracking-wide" style={{ color: '#6B63F6' }}>专属副本结果</h1>
              </header>

              <div
                className="flex-1 overflow-y-auto px-5 z-20"
                style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', paddingBottom: 'max(34px, env(safe-area-inset-bottom))' }}
              >
                <ResultBody
                  purpose={purpose}
                  people={people}
                  mood={mood}
                  places={places}
                  segments={segments}
                  routeTitle={routeTitle}
                  locationLabel={routeLocationLabel}
                  dataSource={routeDataSource}
                  emptyReason={routeErrors[0] || ''}
                  onReset={handleReset}
                  onPlaceClick={handlePlaceClick}
                  onOrder={handleOrderClick}
                  orderLoading={orderLoading}
                />
              </div>
            </motion.div>
          )}
          {currentView === 'agent-processing' && (
            <motion.div
              key="agent-processing"
              className="absolute inset-0 flex flex-col z-50 bg-[#F7F8FC] h-full"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
            >
              <AgentProcessingPage
                phase={processingPhase}
                conflictReason={conflictReason}
                onBack={() => setCurrentView('result')}
                onConflict={() => { setHasConflict(true); setProcessingPhase('conflict'); }}
                onPrimary={() => {
                  if (processingPhase === 'conflict') {
                    setCurrentView('conflict-resolve');
                  } else {
                    setCurrentView('agent-execution');
                  }
                }}
                tasks={processingTasks}
              />
            </motion.div>
          )}

          {currentView === 'voucher' && (
            <motion.div
              key="voucher"
              className="absolute inset-0 flex flex-col z-[60] bg-[#F7F8FC] h-full"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
            >
              <VoucherPage
                index={voucherIndex}
                tasks={executionTasks}
                voucherCode={inferVoucherCode(executionTasks[voucherIndex] || executionTasks[0])}
                onBack={() => setCurrentView('agent-execution')}
                onVerify={handleVoucherVerify}
              />
            </motion.div>
          )}

          {currentView === 'agent-execution' && (
            <motion.div
              key="agent-execution"
              className="absolute inset-0 flex flex-col z-50 bg-[#F7F8FC] h-full"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
            >
              <AgentExecutionPage
                onBack={() => setCurrentView('result')}
                onOpenVoucher={(i) => { setVoucherIndex(i); setCurrentView('voucher'); }}
                tasksInput={executionTasks}
                places={places}
                origin={originCoord}
              />
            </motion.div>
          )}

          {currentView === 'conflict-detected' && (
            <motion.div
              key="conflict-detected"
              className="absolute inset-0 flex flex-col z-[55] bg-[#F7F8FC] h-full"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
            >
              <AgentConflictDetectedPage
                hasConflict={hasConflict}
                onBack={() => setCurrentView('result')}
                onResolve={() => setCurrentView(hasConflict ? 'conflict-resolve' : 'agent-execution')}
                conflictReason={conflictReason}
              />
            </motion.div>
          )}

          {currentView === 'conflict-resolve' && (
            <motion.div
              key="conflict-resolve"
              className="absolute inset-0 flex flex-col z-[56] bg-[#F7F8FC] h-full"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
            >
              <ConflictResolvePage
                onBack={() => setCurrentView('agent-processing')}
                conflictReason={conflictReason}
                solutions={conflictSolutions}
                onAdopt={async (which) => {
                  if (!sessionId) return;
                  try {
                    setCurrentView('agent-processing');
                    await resolveConflict({ session_id: sessionId, choice: which }, async (evt) => {
                      if (isSseEvent(evt, 'plan_ready')) {
                        // 换店/删点后,用更新过的完整方案重建地图、地点、执行列表,确保真正生效
                        applyPlanState((evt.data as any).plan_state || {});
                      }
                      if (isSseEvent(evt, 'action_progress')) {
                        const payload = evt.data;
                        setProcessingTasks((prev) => [...prev, String(payload.detail || '执行中...')]);
                      }
                      if (isSseEvent(evt, 'done')) {
                        setCurrentView(which === 0 || which === 2 ? 'agent-execution-updated' : 'agent-execution');
                      }
                      if (isSseEvent(evt, 'error')) {
                        const message = String(evt.data.message || '冲突处理失败');
                        setApiError(message);
                        toast(message, { duration: 1800 });
                        setCurrentView('conflict-resolve');
                      }
                    });
                  } catch (error) {
                    const message = error instanceof Error ? error.message : '冲突处理失败';
                    setApiError(message);
                    toast(message, { duration: 1800 });
                    setCurrentView('conflict-resolve');
                  }
                }}
              />
            </motion.div>
          )}

          {currentView === 'agent-execution-updated' && (
            <motion.div
              key="agent-execution-updated"
              className="absolute inset-0 flex flex-col z-[57] bg-[#F7F8FC] h-full"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
            >
              <AgentExecutionPage
                variant="updated"
                onBack={() => setCurrentView('result')}
                onOpenVoucher={(i) => { setVoucherIndex(i); setCurrentView('voucher'); }}
                tasksInput={executionTasks}
                places={places}
                origin={originCoord}
              />
            </motion.div>
          )}

          {currentView === 'mission-complete' && (
            <motion.div
              key="mission-complete"
              className="absolute inset-0 flex flex-col z-[72] bg-[#F7F8FC] h-full"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            >
              {/* 底层:作为静态背景,屏蔽交互 */}
              <div className="absolute inset-0 pointer-events-none">
                <SuccessCompletionPage onBackToHome={() => {}} data={completionData ?? buildCompletionData()} />
              </div>
              {/* 浮层:点击任意处进入 success-completion */}
              <MissionCompleteOverlayPage
                onTapAnywhere={() => setCurrentView('success-completion')}
                routeName={(completionData ?? buildCompletionData()).routeName}
              />
            </motion.div>
          )}

          {currentView === 'success-completion' && (
            <motion.div
              key="success-completion"
              className="absolute inset-0 flex flex-col z-[70] bg-[#F7F8FC] h-full"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              <SuccessCompletionPage onBackToHome={() => setCurrentView('intro')} data={completionData ?? buildCompletionData()} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}
