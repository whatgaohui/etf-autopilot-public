'use client';

/**
 * Motion Primitives — 动效原语库
 * 基于 Framer Motion，提供可复用的进场/交互动效组件
 * 参考 Linear / Vercel 的克制动效语言
 */

import React from 'react';
import { motion, AnimatePresence, type Variants, type HTMLMotionProps } from 'framer-motion';

/* ---------- 缓动函数 ---------- */
export const EASE = [0.16, 1, 0.3, 1] as const;        // out-expo
export const EASE_SPRING = [0.34, 1.56, 0.64, 1] as const; // spring

/* ---------- 通用 Variants ---------- */
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.3, ease: EASE } },
};

export const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.95 },
  show: { opacity: 1, scale: 1, transition: { duration: 0.25, ease: EASE_SPRING } },
};

export const slideInRight: Variants = {
  hidden: { opacity: 0, x: 12 },
  show: { opacity: 1, x: 0, transition: { duration: 0.3, ease: EASE } },
};

/* ---------- 容器与子项（列表错落进场） ---------- */
export const staggerContainer = (stagger = 0.05, delay = 0): Variants => ({
  hidden: {},
  show: {
    transition: {
      staggerChildren: stagger,
      delayChildren: delay,
    },
  },
});

/* ---------- 组件：FadeIn ---------- */
interface FadeInProps extends HTMLMotionProps<'div'> {
  delay?: number;
  duration?: number;
}
export function FadeIn({ children, delay = 0, duration = 0.3, ...props }: FadeInProps) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration, delay, ease: EASE }}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/* ---------- 组件：FadeInUp ---------- */
export function FadeInUp({ children, delay = 0, duration = 0.4, ...props }: FadeInProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration, delay, ease: EASE }}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/* ---------- 组件：StaggerItem ---------- */
export function StaggerItem({
  children,
  variants = fadeInUp,
  className,
  ...props
}: HTMLMotionProps<'div'> & { variants?: Variants }) {
  return (
    <motion.div
      variants={variants}
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/* ---------- 组件：PageTransition（Tab 切换淡入淡出） ---------- */
export function PageTransition({ children, k }: { children: React.ReactNode; k: string }) {
  return (
    <motion.div
      key={k}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.28, ease: EASE }}
      className="min-h-[200px]"
    >
      {children}
    </motion.div>
  );
}

/* ---------- 组件：ScaleIn（模态框弹入） ---------- */
export function ScaleInModal({ children, delay = 0, ...props }: FadeInProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.25, delay, ease: EASE_SPRING }}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/* ---------- Hover 交互预设 ---------- */
export const hoverLift = {
  whileHover: { y: -2 },
  transition: { duration: 0.2, ease: EASE },
};

export const hoverCardLift = {
  whileHover: { y: -3 },
  transition: { duration: 0.25, ease: EASE },
};

/* ---------- AnimatePresence 工具（用于数据列表刷新） ---------- */
export { AnimatePresence, motion };
