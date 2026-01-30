import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Copy, RefreshCw, X } from "lucide-react";

const TASK_TYPES = ['data_extraction', 'content_generation', 'code_review', 'classification', 'transformation', 'verification', 'other'];

function generateApiKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = 'clw_';
  for (let i = 0; i < 32; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

export default function WorkerForm({ worker, onSubmit, onCancel }) {
  const [formData, setFormData] = useState(worker || {
    name: '',
    api_key: generateApiKey(),
    status: 'active',
    description: '',
    capabilities: [],
    rate_limit_per_hour: 60
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(formData);
  };

  const toggleCapability = (cap) => {
    const caps = formData.capabilities || [];
    if (caps.includes(cap)) {
      setFormData({ ...formData, capabilities: caps.filter(c => c !== cap) });
    } else {
      setFormData({ ...formData, capabilities: [...caps, cap] });
    }
  };

  const copyApiKey = () => {
    navigator.clipboard.writeText(formData.api_key);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label className="text-slate-400 text-xs uppercase tracking-wider">Worker Name</Label>
          <Input
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder="agent.alpha"
            className="bg-slate-900 border-slate-700 text-slate-100 font-mono"
            required
          />
        </div>
        <div className="space-y-2">
          <Label className="text-slate-400 text-xs uppercase tracking-wider">Status</Label>
          <Select value={formData.status} onValueChange={(v) => setFormData({ ...formData, status: v })}>
            <SelectTrigger className="bg-slate-900 border-slate-700 text-slate-100">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              <SelectItem value="active" className="text-green-400">Active</SelectItem>
              <SelectItem value="suspended" className="text-yellow-400">Suspended</SelectItem>
              <SelectItem value="revoked" className="text-red-400">Revoked</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-slate-400 text-xs uppercase tracking-wider">API Key</Label>
        <div className="flex gap-2">
          <Input
            value={formData.api_key}
            readOnly
            className="bg-slate-900 border-slate-700 text-amber-400 font-mono text-sm"
          />
          <Button type="button" variant="outline" size="icon" onClick={copyApiKey} className="border-slate-700">
            <Copy className="w-4 h-4 text-slate-400" />
          </Button>
          {!worker && (
            <Button type="button" variant="outline" size="icon" onClick={() => setFormData({ ...formData, api_key: generateApiKey() })} className="border-slate-700">
              <RefreshCw className="w-4 h-4 text-slate-400" />
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-slate-400 text-xs uppercase tracking-wider">Description</Label>
        <Textarea
          value={formData.description}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          placeholder="Agent capabilities and purpose..."
          className="bg-slate-900 border-slate-700 text-slate-100 min-h-[80px] font-mono text-sm"
        />
      </div>

      <div className="space-y-2">
        <Label className="text-slate-400 text-xs uppercase tracking-wider">Capabilities</Label>
        <div className="flex flex-wrap gap-2">
          {TASK_TYPES.map(cap => (
            <button
              key={cap}
              type="button"
              onClick={() => toggleCapability(cap)}
              className={`px-3 py-1 text-xs font-mono rounded border transition-all ${
                formData.capabilities?.includes(cap)
                  ? 'bg-amber-600/20 border-amber-600 text-amber-400'
                  : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
              }`}
            >
              {cap}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-slate-400 text-xs uppercase tracking-wider">Rate Limit (per hour)</Label>
        <Input
          type="number"
          value={formData.rate_limit_per_hour}
          onChange={(e) => setFormData({ ...formData, rate_limit_per_hour: parseInt(e.target.value) || 60 })}
          className="bg-slate-900 border-slate-700 text-slate-100 font-mono w-32"
        />
      </div>

      <div className="flex justify-end gap-3 pt-4 border-t border-slate-800">
        <Button type="button" variant="ghost" onClick={onCancel} className="text-slate-400">
          Cancel
        </Button>
        <Button type="submit" className="bg-amber-600 hover:bg-amber-500 text-slate-900">
          {worker ? 'Update Worker' : 'Create Worker'}
        </Button>
      </div>
    </form>
  );
}