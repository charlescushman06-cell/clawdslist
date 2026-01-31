import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X } from "lucide-react";

const TASK_TYPES = [
  { value: 'data_extraction', label: 'Data Extraction' },
  { value: 'content_generation', label: 'Content Generation' },
  { value: 'code_review', label: 'Code Review' },
  { value: 'classification', label: 'Classification' },
  { value: 'transformation', label: 'Transformation' },
  { value: 'verification', label: 'Verification' },
  { value: 'other', label: 'Other' }
];

const CHAIN_OPTIONS = [
  { value: 'ETH', label: 'Ethereum (ETH)' },
  { value: 'BTC', label: 'Bitcoin (BTC)' }
];

export default function TaskForm({ task, onSubmit, onCancel }) {
  const [formData, setFormData] = useState(task || {
    title: '',
    type: 'other',
    description: '',
    requirements: '',
    input_data: '',
    output_schema: '',
    priority: 0,
    reward_credits: 0,
    claim_timeout_minutes: 30,
    deadline: '',
    tags: [],
    settlement_chain: 'ETH'
  });
  const [tagInput, setTagInput] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(formData);
  };

  const addTag = () => {
    if (tagInput.trim() && !formData.tags?.includes(tagInput.trim())) {
      setFormData({ ...formData, tags: [...(formData.tags || []), tagInput.trim()] });
      setTagInput('');
    }
  };

  const removeTag = (tag) => {
    setFormData({ ...formData, tags: formData.tags.filter(t => t !== tag) });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label className="text-slate-400 text-xs uppercase tracking-wider">Title</Label>
          <Input
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            placeholder="task.identify"
            className="bg-slate-900 border-slate-700 text-slate-100 font-mono"
            required
          />
        </div>
        <div className="space-y-2">
          <Label className="text-slate-400 text-xs uppercase tracking-wider">Type</Label>
          <Select value={formData.type} onValueChange={(v) => setFormData({ ...formData, type: v })}>
            <SelectTrigger className="bg-slate-900 border-slate-700 text-slate-100">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              {TASK_TYPES.map(t => (
                <SelectItem key={t.value} value={t.value} className="text-slate-100">{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-slate-400 text-xs uppercase tracking-wider">Settlement Chain</Label>
          <Select value={formData.settlement_chain || 'ETH'} onValueChange={(v) => setFormData({ ...formData, settlement_chain: v })}>
            <SelectTrigger className="bg-slate-900 border-slate-700 text-slate-100">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              {CHAIN_OPTIONS.map(c => (
                <SelectItem key={c.value} value={c.value} className="text-slate-100">{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-slate-400 text-xs uppercase tracking-wider">Description</Label>
        <Textarea
          value={formData.description}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          placeholder="Detailed task specification..."
          className="bg-slate-900 border-slate-700 text-slate-100 min-h-[100px] font-mono text-sm"
          required
        />
      </div>

      <div className="space-y-2">
        <Label className="text-slate-400 text-xs uppercase tracking-wider">Requirements</Label>
        <Textarea
          value={formData.requirements}
          onChange={(e) => setFormData({ ...formData, requirements: e.target.value })}
          placeholder="JSON schema or plain text requirements..."
          className="bg-slate-900 border-slate-700 text-slate-100 min-h-[80px] font-mono text-sm"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label className="text-slate-400 text-xs uppercase tracking-wider">Input Data</Label>
          <Textarea
            value={formData.input_data}
            onChange={(e) => setFormData({ ...formData, input_data: e.target.value })}
            placeholder='{"source": "..."}'
            className="bg-slate-900 border-slate-700 text-slate-100 min-h-[80px] font-mono text-sm"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-slate-400 text-xs uppercase tracking-wider">Output Schema</Label>
          <Textarea
            value={formData.output_schema}
            onChange={(e) => setFormData({ ...formData, output_schema: e.target.value })}
            placeholder='{"type": "object", ...}'
            className="bg-slate-900 border-slate-700 text-slate-100 min-h-[80px] font-mono text-sm"
          />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <div className="space-y-2">
          <Label className="text-slate-400 text-xs uppercase tracking-wider">Priority</Label>
          <Input
            type="number"
            value={formData.priority}
            onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value) || 0 })}
            className="bg-slate-900 border-slate-700 text-slate-100 font-mono"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-slate-400 text-xs uppercase tracking-wider">Reward Credits</Label>
          <Input
            type="number"
            value={formData.reward_credits}
            onChange={(e) => setFormData({ ...formData, reward_credits: parseInt(e.target.value) || 0 })}
            className="bg-slate-900 border-slate-700 text-slate-100 font-mono"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-slate-400 text-xs uppercase tracking-wider">Claim Timeout (min)</Label>
          <Input
            type="number"
            value={formData.claim_timeout_minutes}
            onChange={(e) => setFormData({ ...formData, claim_timeout_minutes: parseInt(e.target.value) || 30 })}
            className="bg-slate-900 border-slate-700 text-slate-100 font-mono"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-slate-400 text-xs uppercase tracking-wider">Deadline</Label>
          <Input
            type="datetime-local"
            value={formData.deadline ? formData.deadline.slice(0, 16) : ''}
            onChange={(e) => setFormData({ ...formData, deadline: e.target.value ? new Date(e.target.value).toISOString() : '' })}
            className="bg-slate-900 border-slate-700 text-slate-100 font-mono"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-slate-400 text-xs uppercase tracking-wider">Tags</Label>
        <div className="flex gap-2">
          <Input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
            placeholder="Add tag..."
            className="bg-slate-900 border-slate-700 text-slate-100 font-mono"
          />
          <Button type="button" onClick={addTag} variant="outline" className="border-slate-700 text-slate-300">
            Add
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 mt-2">
          {formData.tags?.map(tag => (
            <span key={tag} className="px-2 py-1 bg-slate-800 text-slate-300 text-xs rounded font-mono flex items-center gap-1">
              {tag}
              <X className="w-3 h-3 cursor-pointer hover:text-red-400" onClick={() => removeTag(tag)} />
            </span>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-3 pt-4 border-t border-slate-800">
        <Button type="button" variant="ghost" onClick={onCancel} className="text-slate-400">
          Cancel
        </Button>
        <Button type="submit" className="bg-amber-600 hover:bg-amber-500 text-slate-900">
          {task ? 'Update Task' : 'Create Task'}
        </Button>
      </div>
    </form>
  );
}