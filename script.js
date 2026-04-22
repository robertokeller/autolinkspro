const fs = require('fs');

const files = [
  'src/pages/admin/AdminUsers.tsx',
  'src/pages/admin/AdminPlans.tsx',
  'src/pages/admin/AdminNotifications.tsx',
  'src/pages/admin/AdminLogs.tsx',
  'src/pages/admin/AdminAccess.tsx',
  'src/pages/admin/AdminMensagens.tsx'
];

for (const file of files) {
  if (fs.existsSync(file)) {
    let content = fs.readFileSync(file, 'utf8');

    // AdminUsers
    content = content.replace('<div className="container max-w-7xl mx-auto p-4 md:p-8 space-y-8 animate-in fade-in duration-700">', '<div className="admin-page max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 animate-in fade-in duration-500 space-y-8">');
    content = content.replace('className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4"', 'className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-6"');
    
    // AdminPlans
    content = content.replace('<div className="container max-w-6xl py-6">', '<div className="admin-page max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 animate-in fade-in duration-500 space-y-8">');
    
    // AdminNotifications
    content = content.replace('<div className="container max-w-4xl py-6 space-y-6">', '<div className="admin-page max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 animate-in fade-in duration-500 space-y-8">');
    
    // AdminLogs
    content = content.replace('<div className="container max-w-[1400px] py-6 space-y-6">', '<div className="admin-page max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-8 animate-in fade-in duration-500 space-y-8">');
    
    // AdminAccess
    content = content.replace('<div className="admin-page max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-6">', '<div className="admin-page max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 animate-in fade-in duration-500 space-y-8">');
    
    // AdminMensagens
    content = content.replace('<div className="container py-8 max-w-7xl space-y-6">', '<div className="admin-page max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 animate-in fade-in duration-500 space-y-8">');
    content = content.replace('<div className="w-full flex-1 max-w-[100vw] overflow-x-hidden p-4 md:p-8 space-y-6 md:space-y-8 animate-in fade-in duration-500">', '<div className="admin-page max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 animate-in fade-in duration-500 space-y-8">');

    fs.writeFileSync(file, content);
  }
}
console.log("Done");
