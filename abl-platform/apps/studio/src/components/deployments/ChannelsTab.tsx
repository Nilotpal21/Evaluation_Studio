/**
 * ChannelsTab — thin router for the three-level channel navigation.
 *
 * Level 1: ChannelCatalog    (grid of channel types with instance counts)
 * Level 2: ChannelInstanceList (table of connections for one type)
 * Level 3: ChannelInstanceConfig (full-width tabbed config for one instance)
 */

'use client';

import { useState, useCallback } from 'react';
import type { ChannelTypeId, ChannelNavLevel } from './channels/types';
import { ChannelCatalog } from './channels/ChannelCatalog';
import { ChannelInstanceList } from './channels/ChannelInstanceList';
import { ChannelInstanceConfig } from './channels/ChannelInstanceConfig';

interface ChannelsTabProps {
  projectId: string;
  onExpanded?: (expanded: boolean) => void;
}

export function ChannelsTab({ projectId, onExpanded }: ChannelsTabProps) {
  const [nav, setNav] = useState<ChannelNavLevel>({ level: 'catalog' });

  const handleSelectType = useCallback((channelType: ChannelTypeId) => {
    setNav({ level: 'list', channelType });
  }, []);

  const handleSelectInstance = useCallback(
    (instanceId: string) => {
      if (nav.level === 'list') {
        setNav({ level: 'config', channelType: nav.channelType, instanceId });
      }
    },
    [nav],
  );

  const handleBackToCatalog = useCallback(() => {
    setNav({ level: 'catalog' });
  }, []);

  const handleBackToList = useCallback(() => {
    if (nav.level === 'config') {
      setNav({ level: 'list', channelType: nav.channelType });
    }
  }, [nav]);

  const handleExpanded = useCallback(
    (expanded: boolean) => {
      onExpanded?.(expanded);
    },
    [onExpanded],
  );

  switch (nav.level) {
    case 'catalog':
      return <ChannelCatalog projectId={projectId} onSelect={handleSelectType} />;

    case 'list':
      return (
        <ChannelInstanceList
          projectId={projectId}
          channelType={nav.channelType}
          onBack={handleBackToCatalog}
          onSelectInstance={handleSelectInstance}
        />
      );

    case 'config':
      return (
        <ChannelInstanceConfig
          projectId={projectId}
          channelType={nav.channelType}
          instanceId={nav.instanceId}
          onBack={handleBackToList}
          onExpanded={handleExpanded}
        />
      );
  }
}
