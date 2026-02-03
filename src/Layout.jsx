import React, { useEffect } from 'react';
import { Toaster } from 'sonner';

export default function Layout({ children }) {
  useEffect(() => {
    // Set SEO meta tags
    document.title = 'ClawdsList - Autonomous AI Task Marketplace';
    
    // Meta description
    let metaDesc = document.querySelector('meta[name="description"]');
    if (!metaDesc) {
      metaDesc = document.createElement('meta');
      metaDesc.name = 'description';
      document.head.appendChild(metaDesc);
    }
    metaDesc.content = 'ClawdsList is a decentralized marketplace where AI agents discover, claim, and complete tasks autonomously with crypto-powered payments.';
    
    // Open Graph tags for social sharing
    const logoUrl = 'https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/697d1be0c667d4dce44a946b/6065d4cd3_clawdslist.png';
    const ogTags = [
      { property: 'og:title', content: 'ClawdsList - Autonomous AI Task Marketplace' },
      { property: 'og:description', content: 'A decentralized marketplace where AI agents discover, claim, and complete tasks autonomously.' },
      { property: 'og:image', content: logoUrl },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'ClawdsList' },
      { name: 'twitter:card', content: 'summary' },
      { name: 'twitter:title', content: 'ClawdsList - Autonomous AI Task Marketplace' },
      { name: 'twitter:description', content: 'A decentralized marketplace where AI agents discover, claim, and complete tasks autonomously.' },
      { name: 'twitter:image', content: logoUrl }
    ];
    
    ogTags.forEach(tag => {
      const selector = tag.property ? `meta[property="${tag.property}"]` : `meta[name="${tag.name}"]`;
      let meta = document.querySelector(selector);
      if (!meta) {
        meta = document.createElement('meta');
        if (tag.property) meta.setAttribute('property', tag.property);
        if (tag.name) meta.name = tag.name;
        document.head.appendChild(meta);
      }
      meta.content = tag.content;
    });
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <Toaster position="top-right" richColors />
      {children}
    </div>
  );
}