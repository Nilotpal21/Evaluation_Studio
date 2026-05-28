'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { SidebarRail } from './SidebarRail';
import { SidebarExpanded } from './SidebarExpanded';

export function Sidebar() {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <aside className="relative flex h-full flex-shrink-0">
      <AnimatePresence mode="wait" initial={false}>
        {isExpanded ? (
          <motion.div
            key="expanded"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 240, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
          >
            <SidebarExpanded onCollapse={() => setIsExpanded(false)} />
          </motion.div>
        ) : (
          <SidebarRail onExpand={() => setIsExpanded(true)} />
        )}
      </AnimatePresence>
    </aside>
  );
}
