import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  Search,
  Waves,
  Activity,
  ChevronDown,
  ChevronRight
} from 'lucide-react';
import { format } from 'date-fns';

const EVENT_COLORS = {
  task_created: 'text-blue-400',
  task_claimed: 'text-amber-400',
  task_released: 'text-slate-400',
  task_completed: 'text-emerald-400',
  task_expired: 'text-slate-500',
  task_disputed: 'text-red-400',
  task_cancelled: 'text-slate-500',
  submission_created: 'text-purple-400',
  submission_approved: 'text-emerald-400',
  submission_rejected: 'text-red-400',
  worker_created: 'text-blue-400',
  worker_suspended: 'text-yellow-400',
  worker_activated: 'text-emerald-400',
  claim_expired: 'text-orange-400',
  system_error: 'text-red-500'
};

export default function Events() {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [expandedEvent, setExpandedEvent] = useState(null);

  const { data: events = [] } = useQuery({
    queryKey: ['events'],
    queryFn: () => base44.entities.Event.list('-created_date', 500)
  });

  const eventTypes = ['all', ...new Set(events.map(e => e.event_type))];

  const filteredEvents = events.filter(event => {
    const matchesSearch = !search || 
      event.event_type?.toLowerCase().includes(search.toLowerCase()) ||
      event.entity_id?.toLowerCase().includes(search.toLowerCase());
    const matchesType = typeFilter === 'all' || event.event_type === typeFilter;
    return matchesSearch && matchesType;
  });

  const parseDetails = (details) => {
    try {
      return JSON.stringify(JSON.parse(details), null, 2);
    } catch {
      return details;
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link to={createPageUrl('Dashboard')} className="p-2 bg-amber-600/20 rounded-lg hover:bg-amber-600/30 transition-colors">
                <Waves className="w-6 h-6 text-amber-500" />
              </Link>
              <div>
                <h1 className="text-xl font-mono font-bold text-slate-100">Events</h1>
                <p className="text-xs text-slate-500 font-mono">System Audit Log</p>
              </div>
            </div>
            <nav className="flex items-center gap-1">
              {[
                { name: 'Dashboard', page: 'Dashboard' },
                { name: 'Tasks', page: 'Tasks' },
                { name: 'Workers', page: 'Workers' },
                { name: 'Submissions', page: 'Submissions' },
                { name: 'Events', page: 'Events', active: true },
                { name: 'API Docs', page: 'ApiDocs' }
              ].map(item => (
                <Link
                  key={item.page}
                  to={createPageUrl(item.page)}
                  className={`px-3 py-2 text-sm font-mono rounded transition-colors ${
                    item.active 
                      ? 'bg-slate-800 text-amber-400' 
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                  }`}
                >
                  {item.name}
                </Link>
              ))}
            </nav>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Toolbar */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search events..."
                className="pl-9 bg-slate-900 border-slate-700 text-slate-100 w-64 font-mono text-sm"
              />
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-48 bg-slate-900 border-slate-700 text-slate-100">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700 max-h-64">
                {eventTypes.map(type => (
                  <SelectItem key={type} value={type} className="text-slate-100 font-mono text-sm">
                    {type === 'all' ? 'All Events' : type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="text-sm font-mono text-slate-500">
            {filteredEvents.length} events
          </div>
        </div>

        {/* Events Log */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg overflow-hidden">
          <div className="divide-y divide-slate-800">
            {filteredEvents.map(event => (
              <div key={event.id} className="hover:bg-slate-800/30 transition-colors">
                <div 
                  className="p-4 flex items-center gap-4 cursor-pointer"
                  onClick={() => setExpandedEvent(expandedEvent === event.id ? null : event.id)}
                >
                  <span className="text-xs font-mono text-slate-600 w-20">
                    {format(new Date(event.created_date), 'HH:mm:ss')}
                  </span>
                  <span className="text-xs font-mono text-slate-500 w-20">
                    {format(new Date(event.created_date), 'MMM d')}
                  </span>
                  <span className={`text-sm font-mono flex-1 ${EVENT_COLORS[event.event_type] || 'text-slate-400'}`}>
                    {event.event_type}
                  </span>
                  <span className="text-xs font-mono text-slate-500 w-24">
                    {event.entity_type}
                  </span>
                  <span className="text-xs font-mono text-slate-600 w-32 truncate">
                    {event.entity_id}
                  </span>
                  <span className="text-xs font-mono text-slate-500 w-20">
                    {event.actor_type}
                  </span>
                  {event.details && (
                    expandedEvent === event.id 
                      ? <ChevronDown className="w-4 h-4 text-slate-500" />
                      : <ChevronRight className="w-4 h-4 text-slate-500" />
                  )}
                </div>
                {expandedEvent === event.id && event.details && (
                  <div className="px-4 pb-4">
                    <pre className="bg-slate-950 border border-slate-800 rounded p-3 text-xs font-mono text-slate-400 overflow-x-auto">
                      {parseDetails(event.details)}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
          {filteredEvents.length === 0 && (
            <div className="p-12 text-center text-slate-500 font-mono">
              No events recorded
            </div>
          )}
        </div>
      </main>
    </div>
  );
}