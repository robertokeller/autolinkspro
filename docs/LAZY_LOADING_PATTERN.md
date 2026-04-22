# Padrão de Lazy Loading Consolidado

## Visão Geral

O frontend agora utiliza um padrão unificado de lazy loading com suspense que:

1. **Lazy Loading Automático**: Todas as páginas são carregadas com `lazy()` de forma automática em `lazy-pages.ts`
2. **Suspense Global**: AppRoutes envolve as rotas em Suspense com LoadingScreen
3. **PageLoadingProvider**: Contexto global para gerenciar loading de dados dentro de páginas
4. **PageWrapper**: Componente para envolver páginas com Suspense localizado

## Estrutura de Carregamento

### 1. Carregamento de Página (Lazy Loading)
Quando o usuário navega para uma página, o componente é carregado dinamicamente:

```tsx
// Em lazy-pages.ts
export const Pages = {
  Dashboard: lazyPage("Dashboard", "/src/pages/Dashboard.tsx", 
    () => import("@/pages/Dashboard")),
  // ...
}

// Em AppRoutes.tsx
export function AppRoutes() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
        {/* As rotas usam Pages.Dashboard etc */}
      </Routes>
    </Suspense>
  );
}
```

Durante o carregamento da página, um `LoadingScreen` é exibido automaticamente.

### 2. Carregamento de Dados Dentro da Página
Para operações que carregam dados **dentro** da página já renderizada:

#### Opção A: Loading State Simples com Hook
```tsx
import { usePageLoadingState } from "@/components/PageLoadingFallback";

export default function MyPage() {
  const { isLoading, setLoading, resetLoading } = usePageLoadingState();
  const [data, setData] = useState(null);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true, "Carregando dados...");
      try {
        const result = await fetchData();
        setData(result);
      } finally {
        setLoading(false);
      }
    };
    loadData();
    return () => resetLoading();
  }, [setLoading, resetLoading]);

  return (
    <div>
      {isLoading ? <InlineLoadingState /> : <div>{data}</div>}
    </div>
  );
}
```

#### Opção B: Skeleton Loading para Components
Use `Skeleton` do componente UI para placeholder visual durante loading:

```tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function MyPage() {
  const { data, isLoading } = useQuery(...);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return <div>{data}</div>;
}
```

## Componentes Disponíveis

### LoadingScreen
- **Uso**: Fallback global para Suspense (páginas carregando)
- **Importar**: `from "@/components/LoadingScreen"`
- **Variante**: "screen" (fullscreen)

### PageLoadingFallback
- **Uso**: Fallback para Suspense dentro de páginas
- **Importar**: `from "@/components/PageLoadingFallback"`
- **Props**: `label?: string` (padrão: "Carregando página...")

### InlineLoadingState
- **Uso**: Loading spinner inline dentro de conteúdo
- **Importar**: `from "@/components/InlineLoadingState"`
- **Props**: `label?: string`, `className?: string`

### InlinePageLoading
- **Uso**: Alternativa minimalista a InlineLoadingState
- **Importar**: `from "@/components/PageLoadingFallback"`
- **Props**: `label?: string`

### Skeleton
- **Uso**: Placeholder visual para conteúdo sendo carregado
- **Importar**: `from "@/components/ui/skeleton"`
- **Props**: CSS classes para altura/largura

### PageWrapper
- **Uso**: Envolver páginas que têm Suspense localizado
- **Importar**: `from "@/components/PageWrapper"`
- **Props**: `fallbackLabel?: string`

```tsx
export default function MyPage() {
  return (
    <PageWrapper fallbackLabel="Carregando...">
      {/* Conteúdo da página */}
    </PageWrapper>
  );
}
```

## Hooks Disponíveis

### usePageLoadingState
Gerencia loading de dados dentro da página:

```tsx
const { isLoading, setLoading, resetLoading } = usePageLoadingState();

// Iniciar loading
setLoading(true, "Processando...");

// Parar loading/reset
setLoading(false);
resetLoading();
```

### usePageLoadingState
Acessar o estado de loading global da página:

```tsx
const { isLoading, loadingMessage, setLoading, resetLoading } = usePageLoadingState();
```

## Padrão de Migração

### Antes (RoutePendingState)
```tsx
export default function MyPage() {
  const { isLoading } = useData();

  if (isLoading) {
    return <RoutePendingState label="Carregando..." />;
  }

  return <div>{/* conteúdo */}</div>;
}
```

### Depois (PageWrapper)
```tsx
import { PageWrapper } from "@/components/PageWrapper";

export default function MyPage() {
  // O isLoading é tratado automaticamente pelo Suspense
  return (
    <PageWrapper fallbackLabel="Carregando...">
      {/* conteúdo */}
    </PageWrapper>
  );
}
```

## Boas Práticas

1. **Use PageWrapper** para páginas inteiras que têm lazy loading
2. **Use InlineLoadingState** para operações dentro da página
3. **Use Skeleton** para placeholder visual de listas/cards
4. **Use usePageLoadingState** para controle fino de loading em operações locais
5. **Evite** component RoutePendingState (descontinuado)
6. **Não crie novos spinners**: Use os componentes padronizados

## Exemplos Completos

### Página com Lazy Loading Automático
```tsx
import { PageWrapper } from "@/components/PageWrapper";
import { PageHeader } from "@/components/PageHeader";

export default function Dashboard() {
  return (
    <PageWrapper fallbackLabel="Carregando painel...">
      <div className="space-y-6">
        <PageHeader title="Dashboard" />
        {/* Conteúdo aqui */}
      </div>
    </PageWrapper>
  );
}
```

### Página com Carregamento de Dados Progressivo
```tsx
import { usePageLoadingState } from "@/components/PageLoadingFallback";
import { InlineLoadingState } from "@/components/InlineLoadingState";

export default function ListPage() {
  const { isLoading, setLoading, resetLoading } = usePageLoadingState();
  const [items, setItems] = useState([]);

  useEffect(() => {
    const loadItems = async () => {
      setLoading(true);
      try {
        const data = await fetchItems();
        setItems(data);
      } finally {
        setLoading(false);
      }
    };
    loadItems();
    return () => resetLoading();
  }, [setLoading, resetLoading]);

  return (
    <div>
      {isLoading && <InlineLoadingState label="Carregando itens..." />}
      {!isLoading && items.map(item => <ItemCard key={item.id} item={item} />)}
    </div>
  );
}
```

### Página com Skeleton Loading
```tsx
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";

export default function ProductList() {
  const { data, isLoading } = useQuery({
    queryKey: ['products'],
    queryFn: fetchProducts,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {data?.map(product => <ProductCard key={product.id} product={product} />)}
    </div>
  );
}
```
