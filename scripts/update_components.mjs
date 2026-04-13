import fs from 'fs';
import path from 'path';

function fixFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Fix common actions container classes to be harmonious
  content = content.replace(/className="flex flex-col gap-2.*?w-full.*?"/g, 'className="flex flex-col sm:flex-row gap-2 w-full"');
  content = content.replace(/className="flex gap-2 w-full.*?"/g, 'className="flex flex-col sm:flex-row gap-2 w-full"');

  // Add mr-2 to lucide icons in buttons
  const iconsToUpdate = ['Plus', 'Trash2', 'RefreshCw', 'Play', 'SquareTerminal', 'Phone', 'MessageSquare', 'LogOut', 'QrCode'];
  
  iconsToUpdate.forEach(icon => {
    const rxClass = new RegExp(`<${icon}\\b([^>]*?)className=(['"])(.*?)(['"])([^>]*?)>`, 'g');
    content = content.replace(rxClass, function(match, pre, q1, classes, q2, post) {
      if (!classes.includes('mr-2')) {
        return `<${icon}${pre}className=${q1}${classes} mr-2${q2}${post}>`;
      }
      return match;
    });

    const rxNoClass = new RegExp(`<${icon}\\s*(?!.*\\bclassName=)([^>]*?)>`, 'g');
    content = content.replace(rxNoClass, `<${icon} className="mr-2 h-4 w-4" $1>`);
  });

  // Ensure DialogFooters stack nicely
  content = content.replace(/className=".*?(flex-col-reverse).*?"|<DialogFooter[^>]*>|<AlertDialogFooter[^>]*>/g, function(m) {
    if (m.startsWith('<Dialog') || m.startsWith('<Alert')) {
      const tag = m.split(/[ >]/)[0];
      return `${tag} className="flex flex-col-reverse sm:flex-row sm:justify-between sm:space-x-2">`;
    }
    if (m.includes('className=')) {
        return m.replace(/className="[^"]*"/, 'className="flex flex-col-reverse sm:flex-row sm:justify-between sm:space-x-2"');
    }
    return m;
  });

  // Fix Text Casing
  const replacements = [
    { from: /Nova sessão/gi, to: "Nova Conexão" },
    { from: /Nova conexão/gi, to: "Nova Conexão" },
    { from: /Adicionar sessão/gi, to: "Nova Conexão" },
    { from: /Sincronizar mensagens/gi, to: "Sincronizar" },
    { from: /Sincronizar Mensagens/g, to: "Sincronizar" },
    { from: /Excluir sessão/gi, to: "Excluir" },
    { from: /Desconectar Sessão/gi, to: "Desconectar" },
  ];

  replacements.forEach(r => {
    content = content.replace(r.from, r.to);
  });

  fs.writeFileSync(filePath, content, 'utf8');
}

const waPath = path.resolve('src/components/conexoes/SessoesWhatsApp.tsx');
const tgPath = path.resolve('src/components/conexoes/SessoesTelegram.tsx');

if (fs.existsSync(waPath)) fixFile(waPath);
if (fs.existsSync(tgPath)) fixFile(tgPath);

console.log('Update script finished.');