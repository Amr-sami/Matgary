import type { Locale } from "./responses";

/**
 * F7 — Server-side AI i18n dictionary.
 *
 * Every user-visible string the AI agent GENERATES itself — confirmation
 * titles/summaries, builder labels, warning fallbacks, period labels,
 * clarification prompts, error messages — is keyed here with a value per
 * supported locale.
 *
 * Gemini still composes free-form prose (`render_text`, warning bodies) in
 * the locked locale. This dictionary covers the deterministic scaffolding
 * only — the content the agent cannot be trusted to translate correctly
 * because it goes through server code paths.
 *
 * Fallback policy (per F7 Part 19):
 *   1. If the locale has a string for the key → use it.
 *   2. Else fall back to English.
 *   3. If English is also missing → return the key itself (dev-visible gap)
 *      and log a WARN so we don't leak silent regressions. Never return an
 *      empty string; never throw.
 *
 * Internal error codes (e.g. "SALES_EMPTY", "AUDIT_WRITE_FAILED") stay in
 * English — they're identifiers, not user strings.
 */

type Dict = Partial<Record<Locale, string>> & { en: string };

/** Interpolate `{var}` placeholders. Safe for missing vars — left as-is. */
function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in vars ? String(vars[k]) : `{${k}}`,
  );
}

const MESSAGES: Record<string, Dict> = {
  /* ─────────────── builder scaffolding ─────────────── */

  "inventorySummary.title": {
    en: "Inventory summary",
    ar: "ملخّص المخزون",
    pt: "Resumo do estoque",
    fr: "Résumé des stocks",
    es: "Resumen del inventario",
  },
  "inventorySummary.empty.title": {
    en: "No products yet",
    ar: "لا يوجد منتجات",
    pt: "Ainda não há produtos",
    fr: "Aucun produit pour l'instant",
    es: "Aún no hay productos",
  },
  "inventorySummary.empty.message": {
    en: "No products are registered in this scope yet.",
    ar: "لا يوجد أي منتج مسجّل في هذا النطاق.",
    pt: "Nenhum produto está registrado neste escopo ainda.",
    fr: "Aucun produit n'est encore enregistré dans ce périmètre.",
    es: "Aún no hay productos registrados en este ámbito.",
  },
  "salesSummary.title": {
    en: "Sales summary",
    ar: "ملخّص المبيعات",
    pt: "Resumo de vendas",
    fr: "Résumé des ventes",
    es: "Resumen de ventas",
  },
  "salesSummary.empty.title": {
    en: "No sales in this period",
    ar: "لا توجد مبيعات",
    pt: "Sem vendas neste período",
    fr: "Aucune vente sur cette période",
    es: "Sin ventas en este período",
  },
  "salesSummary.empty.message": {
    en: 'No sales were recorded during "{period}".',
    ar: 'لا توجد عمليات بيع في فترة "{period}".',
    pt: 'Nenhuma venda registrada durante "{period}".',
    fr: 'Aucune vente enregistrée pendant « {period} ».',
    es: 'No se registraron ventas durante "{period}".',
  },
  "salesSummary.topProduct.label": {
    en: "Top product: {name}",
    ar: "الأكثر مبيعًا: {name}",
    pt: "Produto mais vendido: {name}",
    fr: "Produit phare : {name}",
    es: "Producto más vendido: {name}",
  },
  "comparison.title": {
    en: "Product comparison",
    ar: "مقارنة المنتجات",
    pt: "Comparação de produtos",
    fr: "Comparaison de produits",
    es: "Comparación de productos",
  },
  "comparison.price.label": {
    en: "Price",
    ar: "السعر",
    pt: "Preço",
    fr: "Prix",
    es: "Precio",
  },
  "comparison.stock.label": {
    en: "Stock",
    ar: "الكمية",
    pt: "Estoque",
    fr: "Stock",
    es: "Stock",
  },
  "comparison.brand.label": {
    en: "Brand",
    ar: "البراند",
    pt: "Marca",
    fr: "Marque",
    es: "Marca",
  },
  "comparison.sku.label": {
    en: "SKU",
    ar: "SKU",
    pt: "SKU",
    fr: "SKU",
    es: "SKU",
  },
  "comparison.fewProducts.title": {
    en: "Comparison not possible",
    ar: "مقارنة غير ممكنة",
    pt: "Comparação não é possível",
    fr: "Comparaison impossible",
    es: "Comparación no posible",
  },
  "comparison.fewProducts.message": {
    en: "At least two products are needed to compare.",
    ar: "تحتاج على الأقل منتجين لإجراء مقارنة.",
    pt: "São necessários pelo menos dois produtos para comparar.",
    fr: "Il faut au moins deux produits pour comparer.",
    es: "Se necesitan al menos dos productos para comparar.",
  },
  "comparison.duplicate.message": {
    en: "Can't compare a product to itself.",
    ar: "لا يمكن مقارنة المنتج بنفسه.",
    pt: "Não dá para comparar um produto consigo mesmo.",
    fr: "Impossible de comparer un produit avec lui-même.",
    es: "No se puede comparar un producto consigo mismo.",
  },
  "comparison.lookupFailed.message": {
    en: "Could not find two valid products to compare.",
    ar: "تعذّر تحديد منتجين صالحين للمقارنة. تأكد من الهوية الصحيحة.",
    pt: "Não foi possível encontrar dois produtos válidos para comparar.",
    fr: "Impossible de trouver deux produits valides à comparer.",
    es: "No se pudieron encontrar dos productos válidos para comparar.",
  },

  /* ─────────────── scope / period labels ─────────────── */

  "scope.allBranches": {
    en: "All branches",
    ar: "كل الفروع",
    pt: "Todas as filiais",
    fr: "Toutes les succursales",
    es: "Todas las sucursales",
  },
  "period.today": {
    en: "Today",
    ar: "اليوم",
    pt: "Hoje",
    fr: "Aujourd'hui",
    es: "Hoy",
  },
  "period.yesterday": {
    en: "Yesterday",
    ar: "أمس",
    pt: "Ontem",
    fr: "Hier",
    es: "Ayer",
  },
  "period.week": {
    en: "Last 7 days",
    ar: "آخر ٧ أيام",
    pt: "Últimos 7 dias",
    fr: "7 derniers jours",
    es: "Últimos 7 días",
  },
  "period.month": {
    en: "Last 30 days",
    ar: "آخر ٣٠ يوم",
    pt: "Últimos 30 dias",
    fr: "30 derniers jours",
    es: "Últimos 30 días",
  },
  "period.quarter": {
    en: "Last 90 days",
    ar: "آخر ٩٠ يوم",
    pt: "Últimos 90 dias",
    fr: "90 derniers jours",
    es: "Últimos 90 días",
  },
  "period.year": {
    en: "Last year",
    ar: "آخر سنة",
    pt: "Último ano",
    fr: "Dernière année",
    es: "Último año",
  },
  "period.all": {
    en: "All time",
    ar: "كل الفترات",
    pt: "Todos os períodos",
    fr: "Toutes les périodes",
    es: "Todos los períodos",
  },

  /* ─────────────── F5 — confirmation + execute ─────────────── */

  "write.price.title": {
    en: 'Change price of "{name}"',
    ar: 'تغيير سعر "{name}"',
    pt: 'Alterar preço de "{name}"',
    fr: 'Modifier le prix de « {name} »',
    es: 'Cambiar precio de "{name}"',
  },
  "write.price.summary": {
    en: "From {before} to {after} EGP.",
    ar: "من {before} إلى {after} ج.م.",
    pt: "De {before} para {after} EGP.",
    fr: "De {before} à {after} EGP.",
    es: "De {before} a {after} EGP.",
  },
  "write.price.actionLabel": {
    en: "Confirm change",
    ar: "تأكيد التغيير",
    pt: "Confirmar alteração",
    fr: "Confirmer la modification",
    es: "Confirmar el cambio",
  },
  "write.quantity.title": {
    en: 'Change stock of "{name}"',
    ar: 'تعديل كمية "{name}"',
    pt: 'Alterar estoque de "{name}"',
    fr: 'Modifier le stock de « {name} »',
    es: 'Cambiar el stock de "{name}"',
  },
  "write.quantity.summary": {
    en: "From {before} to {after}.",
    ar: "من {before} إلى {after}.",
    pt: "De {before} para {after}.",
    fr: "De {before} à {after}.",
    es: "De {before} a {after}.",
  },
  "write.quantity.actionLabel": {
    en: "Confirm change",
    ar: "تأكيد التعديل",
    pt: "Confirmar alteração",
    fr: "Confirmer la modification",
    es: "Confirmar el cambio",
  },
  "write.customer.title": {
    en: "Create a new customer",
    ar: "إنشاء عميل جديد",
    pt: "Criar um novo cliente",
    fr: "Créer un nouveau client",
    es: "Crear un nuevo cliente",
  },
  "write.customer.summary.alreadyExists": {
    en: "Customer {label} already exists in this branch. Confirming will not create a duplicate.",
    ar: "العميل {label} موجود بالفعل في الفرع. التأكيد لن ينشئ تكرارًا.",
    pt: "O cliente {label} já existe nesta filial. Confirmar não criará uma duplicata.",
    fr: "Le client {label} existe déjà dans cette succursale. Confirmer ne créera pas de doublon.",
    es: "El cliente {label} ya existe en esta sucursal. Confirmar no creará un duplicado.",
  },
  "write.customer.actionLabel": {
    en: "Confirm create",
    ar: "تأكيد إنشاء العميل",
    pt: "Confirmar criação",
    fr: "Confirmer la création",
    es: "Confirmar creación",
  },

  /* ─────── Wave 1 — catalog authoring (create/update product, create brand/category) ─── */
  "write.missingFields": {
    en: "I need the following to proceed: {fields}.",
    ar: "محتاج المعلومات دي عشان أكمل: {fields}.",
    pt: "Preciso dos seguintes campos para continuar: {fields}.",
    fr: "J'ai besoin des informations suivantes pour continuer : {fields}.",
    es: "Necesito la siguiente información para continuar: {fields}.",
  },
  "write.field.name": {
    en: "name", ar: "الاسم", pt: "nome", fr: "nom", es: "nombre",
  },
  "write.field.category": {
    en: "category", ar: "التصنيف", pt: "categoria", fr: "catégorie", es: "categoría",
  },
  "write.field.brand": {
    en: "brand", ar: "البراند", pt: "marca", fr: "marque", es: "marca",
  },
  "write.field.price": {
    en: "selling price", ar: "سعر البيع", pt: "preço de venda", fr: "prix de vente", es: "precio de venta",
  },
  "write.field.quantity": {
    en: "quantity", ar: "الكمية", pt: "quantidade", fr: "quantité", es: "cantidad",
  },
  "write.field.label": {
    en: "label", ar: "الاسم المعروض", pt: "rótulo", fr: "libellé", es: "etiqueta",
  },
  "write.categoryUnknown": {
    en: 'Category "{name}" doesn\'t exist yet. Do you want me to add it first?',
    ar: 'تصنيف "{name}" مش موجود. تحب أضيفه الأول؟',
    pt: 'A categoria "{name}" ainda não existe. Deseja que eu a crie primeiro?',
    fr: 'La catégorie « {name} » n\'existe pas encore. Voulez-vous que je la crée d\'abord ?',
    es: 'La categoría "{name}" aún no existe. ¿Quieres que la cree primero?',
  },
  "write.categoryAmbiguous": {
    en: 'Which category did you mean by "{query}"?',
    ar: 'أي تصنيف قصدت بـ "{query}"؟',
    pt: 'A qual categoria você se referiu por "{query}"?',
    fr: 'Quelle catégorie avez-vous voulu dire par « {query} » ?',
    es: '¿A qué categoría te referiste con "{query}"?',
  },

  "write.productCreate.title": {
    en: 'Add product — "{name}"',
    ar: 'إضافة منتج — "{name}"',
    pt: 'Adicionar produto — "{name}"',
    fr: 'Ajouter un produit — « {name} »',
    es: 'Agregar producto — "{name}"',
  },
  "write.productCreate.actionLabel": {
    en: "Confirm add",
    ar: "تأكيد الإضافة",
    pt: "Confirmar adição",
    fr: "Confirmer l'ajout",
    es: "Confirmar agregado",
  },
  "write.productCreate.row.name": {
    en: "Name: {v}", ar: "الاسم: {v}", pt: "Nome: {v}", fr: "Nom : {v}", es: "Nombre: {v}",
  },
  "write.productCreate.row.category": {
    en: "Category: {v}", ar: "التصنيف: {v}", pt: "Categoria: {v}", fr: "Catégorie : {v}", es: "Categoría: {v}",
  },
  "write.productCreate.row.brand": {
    en: "Brand: {v}", ar: "البراند: {v}", pt: "Marca: {v}", fr: "Marque : {v}", es: "Marca: {v}",
  },
  "write.productCreate.row.price": {
    en: "Price: {v} EGP", ar: "السعر: {v} ج.م", pt: "Preço: {v} EGP", fr: "Prix : {v} EGP", es: "Precio: {v} EGP",
  },
  "write.productCreate.row.quantity": {
    en: "Quantity: {v}", ar: "الكمية: {v}", pt: "Quantidade: {v}", fr: "Quantité : {v}", es: "Cantidad: {v}",
  },
  "write.productCreate.row.cost": {
    en: "Cost: {v} EGP", ar: "التكلفة: {v} ج.م", pt: "Custo: {v} EGP", fr: "Coût : {v} EGP", es: "Costo: {v} EGP",
  },

  "write.productUpdate.title": {
    en: 'Update product — "{name}"',
    ar: 'تعديل المنتج — "{name}"',
    pt: 'Atualizar produto — "{name}"',
    fr: 'Modifier le produit — « {name} »',
    es: 'Actualizar producto — "{name}"',
  },
  "write.productUpdate.actionLabel": {
    en: "Confirm update",
    ar: "تأكيد التعديل",
    pt: "Confirmar atualização",
    fr: "Confirmer la modification",
    es: "Confirmar actualización",
  },
  "write.productUpdate.needTarget": {
    en: "Which product do you want to update? Give me the name or SKU.",
    ar: "أنهي منتج تحب تعدله؟ قوللي الاسم أو الـ SKU.",
    pt: "Qual produto você quer atualizar? Envie o nome ou o SKU.",
    fr: "Quel produit souhaitez-vous modifier ? Indiquez-moi le nom ou le SKU.",
    es: "¿Qué producto quieres actualizar? Dime el nombre o el SKU.",
  },
  "write.productUpdate.nothingToChange": {
    en: "Nothing to update — you didn't specify any changed fields.",
    ar: "مفيش حاجة للتعديل — ماقلتليش أي حقل أغيّره.",
    pt: "Nada para atualizar — nenhum campo foi alterado.",
    fr: "Rien à mettre à jour — aucun champ modifié.",
    es: "Nada que actualizar — no especificaste campos modificados.",
  },
  "write.productUpdate.row.name": {
    en: "Name → {v}", ar: "الاسم → {v}", pt: "Nome → {v}", fr: "Nom → {v}", es: "Nombre → {v}",
  },
  "write.productUpdate.row.brand": {
    en: "Brand → {v}", ar: "البراند → {v}", pt: "Marca → {v}", fr: "Marque → {v}", es: "Marca → {v}",
  },
  "write.productUpdate.row.sku": {
    en: "SKU → {v}", ar: "SKU → {v}", pt: "SKU → {v}", fr: "SKU → {v}", es: "SKU → {v}",
  },
  "write.productUpdate.row.category": {
    en: "Category → {v}", ar: "التصنيف → {v}", pt: "Categoria → {v}", fr: "Catégorie → {v}", es: "Categoría → {v}",
  },
  "write.productUpdate.row.cost": {
    en: "Cost → {v} EGP", ar: "التكلفة → {v} ج.م", pt: "Custo → {v} EGP", fr: "Coût → {v} EGP", es: "Costo → {v} EGP",
  },
  "write.productUpdate.row.threshold": {
    en: "Low-stock → {v}", ar: "حد التنبيه → {v}", pt: "Estoque mín. → {v}", fr: "Seuil bas → {v}", es: "Umbral bajo → {v}",
  },

  "write.brandCreate.title": {
    en: 'Add brand — "{name}"',
    ar: 'إضافة براند — "{name}"',
    pt: 'Adicionar marca — "{name}"',
    fr: 'Ajouter une marque — « {name} »',
    es: 'Agregar marca — "{name}"',
  },
  "write.brandCreate.summary": {
    en: 'Create a new brand "{name}" available to all categories.',
    ar: 'إنشاء براند جديد "{name}" متاح لكل التصنيفات.',
    pt: 'Criar uma nova marca "{name}" disponível para todas as categorias.',
    fr: 'Créer une nouvelle marque « {name} » disponible pour toutes les catégories.',
    es: 'Crear una nueva marca "{name}" disponible para todas las categorías.',
  },
  "write.brandCreate.summaryScoped": {
    en: 'Create brand "{name}" under category "{category}".',
    ar: 'إنشاء براند "{name}" تحت تصنيف "{category}".',
    pt: 'Criar a marca "{name}" na categoria "{category}".',
    fr: 'Créer la marque « {name} » dans la catégorie « {category} ».',
    es: 'Crear la marca "{name}" en la categoría "{category}".',
  },
  "write.brandCreate.actionLabel": {
    en: "Confirm brand", ar: "تأكيد البراند", pt: "Confirmar marca", fr: "Confirmer la marque", es: "Confirmar marca",
  },
  "write.brandCreate.alreadyExists": {
    en: 'Brand "{name}" already exists. No change needed.',
    ar: 'البراند "{name}" موجود بالفعل. مش محتاج تعديل.',
    pt: 'A marca "{name}" já existe. Nenhuma alteração necessária.',
    fr: 'La marque « {name} » existe déjà. Aucun changement nécessaire.',
    es: 'La marca "{name}" ya existe. No se necesita ningún cambio.',
  },

  "write.categoryCreate.title": {
    en: 'Add category — "{label}"',
    ar: 'إضافة تصنيف — "{label}"',
    pt: 'Adicionar categoria — "{label}"',
    fr: 'Ajouter une catégorie — « {label} »',
    es: 'Agregar categoría — "{label}"',
  },
  "write.categoryCreate.summary": {
    en: 'Create a new category "{label}".',
    ar: 'إنشاء تصنيف جديد "{label}".',
    pt: 'Criar uma nova categoria "{label}".',
    fr: 'Créer une nouvelle catégorie « {label} ».',
    es: 'Crear una nueva categoría "{label}".',
  },
  "write.categoryCreate.actionLabel": {
    en: "Confirm category", ar: "تأكيد التصنيف", pt: "Confirmar categoria", fr: "Confirmer la catégorie", es: "Confirmar categoría",
  },
  "write.categoryCreate.alreadyExists": {
    en: 'Category "{label}" already exists. No change needed.',
    ar: 'تصنيف "{label}" موجود بالفعل. مش محتاج تعديل.',
    pt: 'A categoria "{label}" já existe. Nenhuma alteração necessária.',
    fr: 'La catégorie « {label} » existe déjà. Aucun changement nécessaire.',
    es: 'La categoría "{label}" ya existe. No se necesita ningún cambio.',
  },

  "execute.productCreate.done": {
    en: 'Created product "{name}" — price {price} EGP, qty {quantity}.',
    ar: 'تم إنشاء المنتج "{name}" — السعر {price} ج.م، الكمية {quantity}.',
    pt: 'Produto "{name}" criado — preço {price} EGP, quantidade {quantity}.',
    fr: 'Produit « {name} » créé — prix {price} EGP, quantité {quantity}.',
    es: 'Producto "{name}" creado — precio {price} EGP, cantidad {quantity}.',
  },
  "execute.productCreate.categoryGone": {
    en: "That category no longer exists. Pick a different one and try again.",
    ar: "التصنيف ده مبقاش موجود. اختار واحد تاني وجرب تاني.",
    pt: "Essa categoria não existe mais. Escolha outra e tente novamente.",
    fr: "Cette catégorie n'existe plus. Choisissez-en une autre et réessayez.",
    es: "Esa categoría ya no existe. Elige otra e inténtalo de nuevo.",
  },
  "execute.productCreate.failed": {
    en: "Could not create the product. Please try again.",
    ar: "ماقدرتش أنشئ المنتج. حاول تاني.",
    pt: "Não foi possível criar o produto. Tente novamente.",
    fr: "Impossible de créer le produit. Veuillez réessayer.",
    es: "No se pudo crear el producto. Inténtalo de nuevo.",
  },
  "execute.productCreate.verifyFailed": {
    en: "The product was written but post-save verification failed. Check the inventory.",
    ar: "تم الكتابة، بس التحقق بعد الحفظ فشل. راجع المخزون.",
    pt: "O produto foi gravado, mas a verificação pós-escrita falhou. Verifique o inventário.",
    fr: "Le produit a été écrit, mais la vérification après écriture a échoué. Vérifiez l'inventaire.",
    es: "El producto se guardó pero la verificación posterior falló. Revisa el inventario.",
  },
  "execute.productUpdate.categoryGone": {
    en: "That category no longer exists. The update was NOT applied.",
    ar: "التصنيف ده مبقاش موجود. التحديث ما اتنفذش.",
    pt: "Essa categoria não existe mais. A atualização NÃO foi aplicada.",
    fr: "Cette catégorie n'existe plus. La modification n'a PAS été appliquée.",
    es: "Esa categoría ya no existe. La actualización NO se aplicó.",
  },
  "execute.productUpdate.failed": {
    en: "Could not update the product. Please try again.",
    ar: "ماقدرتش أحدّث المنتج. حاول تاني.",
    pt: "Não foi possível atualizar o produto. Tente novamente.",
    fr: "Impossible de mettre à jour le produit. Veuillez réessayer.",
    es: "No se pudo actualizar el producto. Inténtalo de nuevo.",
  },
  "execute.productUpdate.verifyFailed": {
    en: "The update may have partially applied. Please check the product.",
    ar: "التحديث قد يكون اتطبق جزئياً. راجع المنتج.",
    pt: "A atualização pode ter sido parcial. Verifique o produto.",
    fr: "La modification peut avoir été partielle. Vérifiez le produit.",
    es: "La actualización puede haberse aplicado parcialmente. Revisa el producto.",
  },
  "execute.brandCreate.failed": {
    en: "Could not create the brand. Please try again.",
    ar: "ماقدرتش أنشئ البراند. حاول تاني.",
    pt: "Não foi possível criar a marca. Tente novamente.",
    fr: "Impossible de créer la marque. Veuillez réessayer.",
    es: "No se pudo crear la marca. Inténtalo de nuevo.",
  },
  "execute.categoryCreate.failed": {
    en: "Could not create the category. Please try again.",
    ar: "ماقدرتش أنشئ التصنيف. حاول تاني.",
    pt: "Não foi possível criar a categoria. Tente novamente.",
    fr: "Impossible de créer la catégorie. Veuillez réessayer.",
    es: "No se pudo crear la categoría. Inténtalo de nuevo.",
  },
  "execute.categoryCreate.verifyFailed": {
    en: "The category was written but didn't appear in the catalog. Please refresh.",
    ar: "التصنيف تم حفظه بس ماظهرش في الكتالوج. حدّث الصفحة.",
    pt: "A categoria foi gravada mas não apareceu no catálogo. Atualize.",
    fr: "La catégorie a été écrite mais n'est pas apparue dans le catalogue. Actualisez.",
    es: "La categoría se guardó pero no apareció en el catálogo. Actualiza.",
  },
  "execute.productUpdate.done": {
    en: 'Updated "{name}" — {changes}.',
    ar: 'تم تحديث "{name}" — {changes}.',
    pt: '"{name}" atualizado — {changes}.',
    fr: '« {name} » mis à jour — {changes}.',
    es: '"{name}" actualizado — {changes}.',
  },
  "execute.brandCreate.done": {
    en: 'Created brand "{name}".',
    ar: 'تم إنشاء البراند "{name}".',
    pt: 'Marca "{name}" criada.',
    fr: 'Marque « {name} » créée.',
    es: 'Marca "{name}" creada.',
  },
  "execute.categoryCreate.done": {
    en: 'Created category "{label}".',
    ar: 'تم إنشاء التصنيف "{label}".',
    pt: 'Categoria "{label}" criada.',
    fr: 'Catégorie « {label} » créée.',
    es: 'Categoría "{label}" creada.',
  },

  "execute.price.done": {
    en: 'Updated "{name}" price from {before} to {after} EGP.',
    ar: 'تم تحديث سعر "{name}" من {before} إلى {after} ج.م.',
    pt: 'Preço de "{name}" atualizado de {before} para {after} EGP.',
    fr: 'Prix de « {name} » mis à jour de {before} à {after} EGP.',
    es: 'Precio de "{name}" actualizado de {before} a {after} EGP.',
  },
  "execute.quantity.done": {
    en: 'Updated "{name}" quantity from {before} to {after}.',
    ar: 'تم تحديث كمية "{name}" من {before} إلى {after}.',
    pt: 'Quantidade de "{name}" atualizada de {before} para {after}.',
    fr: 'Quantité de « {name} » mise à jour de {before} à {after}.',
    es: 'Cantidad de "{name}" actualizada de {before} a {after}.',
  },
  "execute.customer.done": {
    en: "Created customer: {name} ({phone}).",
    ar: "تم إنشاء العميل: {name} ({phone}).",
    pt: "Cliente criado: {name} ({phone}).",
    fr: "Client créé : {name} ({phone}).",
    es: "Cliente creado: {name} ({phone}).",
  },
  "execute.customer.existed": {
    en: "Customer already exists: {label}.",
    ar: "العميل موجود بالفعل: {label}.",
    pt: "O cliente já existe: {label}.",
    fr: "Le client existe déjà : {label}.",
    es: "El cliente ya existe: {label}.",
  },
  "execute.invalidParams": {
    en: "Could not execute — invalid values.",
    ar: "تعذّر تنفيذ العملية — قيم غير صالحة.",
    pt: "Não foi possível executar — valores inválidos.",
    fr: "Impossible d'exécuter — valeurs invalides.",
    es: "No se pudo ejecutar — valores inválidos.",
  },
  "execute.productGone": {
    en: "That product no longer exists.",
    ar: "المنتج لم يعد موجودًا في النظام.",
    pt: "Este produto não existe mais.",
    fr: "Ce produit n'existe plus.",
    es: "Ese producto ya no existe.",
  },
  "execute.updatePriceFailed": {
    en: "Could not update the price.",
    ar: "تعذّر تحديث السعر.",
    pt: "Não foi possível atualizar o preço.",
    fr: "Impossible de mettre à jour le prix.",
    es: "No se pudo actualizar el precio.",
  },
  "execute.updateQtyFailed": {
    en: "Could not change the quantity.",
    ar: "تعذّر تعديل الكمية.",
    pt: "Não foi possível alterar a quantidade.",
    fr: "Impossible de modifier la quantité.",
    es: "No se pudo cambiar la cantidad.",
  },
  "execute.priceVerifyFailed": {
    en: "Price update did not persist. Please re-check the product manually.",
    ar: "تحديث السعر لم يُثبت في قاعدة البيانات. راجع المنتج يدويًا.",
    pt: "A atualização de preço não foi persistida. Verifique o produto manualmente.",
    fr: "La mise à jour du prix n'a pas été enregistrée. Vérifiez le produit manuellement.",
    es: "La actualización de precio no persistió. Verifique el producto manualmente.",
  },
  "execute.qtyVerifyFailed": {
    en: "Quantity change did not persist. Please re-check manually.",
    ar: "تعديل الكمية لم يُثبت. راجع المنتج يدويًا.",
    pt: "A alteração de quantidade não foi persistida. Verifique manualmente.",
    fr: "Le changement de quantité n'a pas été enregistré. Vérifiez manuellement.",
    es: "El cambio de cantidad no persistió. Verifique manualmente.",
  },
  "execute.customerInvalid": {
    en: "Could not create the customer — missing required fields.",
    ar: "تعذّر إنشاء العميل — بيانات ناقصة.",
    pt: "Não foi possível criar o cliente — campos obrigatórios ausentes.",
    fr: "Impossible de créer le client — champs requis manquants.",
    es: "No se pudo crear el cliente — faltan campos obligatorios.",
  },
  "execute.customerVerifyFailed": {
    en: "Could not verify customer creation in the database.",
    ar: "تعذّر إثبات إنشاء العميل في قاعدة البيانات.",
    pt: "Não foi possível verificar a criação do cliente no banco de dados.",
    fr: "Impossible de vérifier la création du client dans la base.",
    es: "No se pudo verificar la creación del cliente en la base de datos.",
  },

  /* ─────────────── F5.1 — audit warning ─────────────── */

  "audit.failed.title": {
    en: "Operations notice",
    ar: "تنبيه تشغيلي",
    pt: "Aviso operacional",
    fr: "Avis opérationnel",
    es: "Aviso operativo",
  },
  "audit.failed.message": {
    en: "The audit log entry for this change failed to write. The database change itself persisted, but ops should be notified to reconcile manually.",
    ar: "فشل تسجيل سجل التدقيق لهذه العملية. التعديل تم بنجاح في قاعدة البيانات، لكن يُنصح بإبلاغ فريق التشغيل لإثبات العملية يدويًا.",
    pt: "A entrada de auditoria para esta alteração falhou. A alteração em si foi persistida, mas é bom notificar operações para reconciliação manual.",
    fr: "L'entrée d'audit pour cette modification n'a pas pu être écrite. La modification a bien été enregistrée, mais prévenez l'équipe d'exploitation pour une réconciliation manuelle.",
    es: "No se pudo escribir la entrada de auditoría de este cambio. El cambio en la base de datos sí se guardó, pero conviene notificar a operaciones para reconciliar manualmente.",
  },

  /* ─────────────── writes.ts — clarify helpers ─────────────── */

  "resolve.noMatch": {
    en: 'No product matched "{query}" in the store. Confirm the spelling or SKU and try again.',
    ar: 'لم أجد منتجًا يطابق "{query}" في المتجر. تأكّد من الاسم أو SKU وجرّب مرة أخرى.',
    pt: 'Nenhum produto corresponde a "{query}" na loja. Confirme o nome ou SKU e tente novamente.',
    fr: 'Aucun produit ne correspond à « {query} » dans la boutique. Vérifiez l\'orthographe ou le SKU puis réessayez.',
    es: 'Ningún producto coincide con "{query}" en la tienda. Confirme la ortografía o el SKU e inténtelo de nuevo.',
  },
  "resolve.ambiguousHeader": {
    en: "Multiple products match — which one?",
    ar: "يوجد أكثر من منتج يطابق الاسم — أيهما تقصد؟",
    pt: "Vários produtos correspondem — qual deles?",
    fr: "Plusieurs produits correspondent — lequel ?",
    es: "Varios productos coinciden — ¿cuál de ellos?",
  },

  /* ─────────────── agent nudges ─────────────── */

  "nudge.renderMissing": {
    en: "You fetched the data but did not call any render_* tool. Now call render_chart / render_table / render_kpi / render_text to show the answer to the user. Do NOT write JSON in content.",
    ar: "استدعيت الأداة وجيبت البيانات، لكن لم تنادِ أي أداة render_*. استخدم render_chart أو render_table أو render_kpi أو render_text لعرض الإجابة للمستخدم الآن. ممنوع كتابة JSON في الـ content.",
    pt: "Você buscou os dados, mas não chamou nenhuma ferramenta render_*. Chame render_chart / render_table / render_kpi / render_text para mostrar a resposta ao usuário agora. NÃO escreva JSON no conteúdo.",
    fr: "Vous avez récupéré les données mais aucun outil render_* n'a été appelé. Appelez maintenant render_chart / render_table / render_kpi / render_text pour afficher la réponse. N'écrivez PAS de JSON dans le contenu.",
    es: "Obtuviste los datos pero no llamaste ninguna herramienta render_*. Llama ya a render_chart / render_table / render_kpi / render_text para mostrar la respuesta al usuario. NO escribas JSON en el contenido.",
  },
  "nudge.capReached.content": {
    en: "I couldn't reach a final answer. Try rephrasing the question.",
    ar: "ما قدرتش أوصل لإجابة نهائية. حاول تصيغ السؤال بشكل أبسط.",
    pt: "Não consegui chegar a uma resposta final. Tente reformular a pergunta.",
    fr: "Je n'ai pas pu formuler de réponse finale. Essayez de reformuler votre question.",
    es: "No pude llegar a una respuesta final. Intenta reformular la pregunta.",
  },
  /* ─────────────── F8 — unavailable / degraded / error states ─────── */

  "error.aiDisabled": {
    en: "The AI assistant is not configured on your store yet.",
    ar: "المساعد الذكي غير مفعّل على متجرك حاليًا.",
    pt: "O assistente de IA ainda não está configurado para sua loja.",
    fr: "L'assistant IA n'est pas encore configuré pour votre boutique.",
    es: "El asistente de IA aún no está configurado para su tienda.",
  },
  "error.aiBusy": {
    en: "The AI is a bit busy right now. Please try again in a moment.",
    ar: "الذكاء الاصطناعي مشغول حاليًا. حاول مرة أخرى بعد لحظات.",
    pt: "A IA está um pouco ocupada no momento. Tente novamente em instantes.",
    fr: "L'IA est un peu occupée pour le moment. Réessayez dans quelques instants.",
    es: "La IA está un poco ocupada en este momento. Inténtalo de nuevo en unos instantes.",
  },
  "error.aiUnavailable": {
    en: "The AI is temporarily unavailable. Please try again shortly.",
    ar: "الذكاء الاصطناعي غير متاح مؤقتًا. حاول مرة أخرى بعد قليل.",
    pt: "A IA está temporariamente indisponível. Tente novamente em breve.",
    fr: "L'IA est temporairement indisponible. Réessayez bientôt.",
    es: "La IA no está disponible temporalmente. Inténtalo de nuevo en breve.",
  },
  "error.aiTimeout": {
    en: "The AI took longer than expected. Please try again.",
    ar: "الرد تأخر أكثر من المعتاد. حاول مرة أخرى.",
    pt: "A IA demorou mais que o esperado. Tente novamente.",
    fr: "L'IA a mis plus de temps que prévu. Veuillez réessayer.",
    es: "La IA tardó más de lo esperado. Inténtalo de nuevo.",
  },

  /* ─────────────── F10.0 — reversible operations ─────────────── */

  "rollback.preview.title": {
    en: 'Undo change to "{name}"',
    ar: 'التراجع عن تعديل "{name}"',
    pt: 'Desfazer alteração em "{name}"',
    fr: 'Annuler la modification de « {name} »',
    es: 'Deshacer el cambio en "{name}"',
  },
  "rollback.preview.description.price": {
    en: 'Restore price from {after} EGP back to {before} EGP.',
    ar: 'استعادة السعر من {after} ج.م إلى {before} ج.م.',
    pt: 'Restaurar o preço de {after} EGP para {before} EGP.',
    fr: 'Rétablir le prix de {after} EGP à {before} EGP.',
    es: 'Restaurar el precio de {after} EGP a {before} EGP.',
  },
  "rollback.preview.description.quantity": {
    en: 'Restore quantity from {after} back to {before}.',
    ar: 'استعادة الكمية من {after} إلى {before}.',
    pt: 'Restaurar a quantidade de {after} para {before}.',
    fr: 'Rétablir la quantité de {after} à {before}.',
    es: 'Restaurar la cantidad de {after} a {before}.',
  },
  "rollback.preview.description.customer": {
    en: 'Delete the customer record for "{name}". The customer has no sales or balance so this is safe.',
    ar: 'حذف بيانات العميل "{name}". العميل لا يملك مبيعات أو رصيد، لذا الحذف آمن.',
    pt: 'Excluir o cliente "{name}". O cliente não tem vendas ou saldo; é seguro excluir.',
    fr: 'Supprimer le client « {name} ». Le client n\'a ni ventes ni solde, cette suppression est sûre.',
    es: 'Eliminar el cliente "{name}". El cliente no tiene ventas ni saldo; es seguro eliminar.',
  },
  "rollback.actionLabel": {
    en: "Confirm undo",
    ar: "تأكيد التراجع",
    pt: "Confirmar desfazer",
    fr: "Confirmer l'annulation",
    es: "Confirmar deshacer",
  },

  "rollback.result.title": {
    en: 'Undo completed for "{name}"',
    ar: 'تم التراجع عن "{name}"',
    pt: 'Alteração desfeita em "{name}"',
    fr: 'Annulation effectuée pour « {name} »',
    es: 'Cambio deshecho en "{name}"',
  },
  "rollback.result.message": {
    en: 'Restored the previous value of {fields} for "{name}".',
    ar: 'تم استعادة القيمة السابقة لـ {fields} لـ "{name}".',
    pt: 'Valor anterior de {fields} restaurado para "{name}".',
    fr: 'Valeur précédente de {fields} rétablie pour « {name} ».',
    es: 'Valor anterior de {fields} restaurado para "{name}".',
  },

  "rollback.conflict.title": {
    en: 'Could not undo "{name}"',
    ar: 'تعذّر التراجع عن "{name}"',
    pt: 'Não foi possível desfazer "{name}"',
    fr: 'Impossible d\'annuler « {name} »',
    es: 'No se pudo deshacer "{name}"',
  },
  "rollback.conflict.concurrentChange": {
    en: "The record was changed after the AI update. I will not overwrite the newer change automatically.",
    ar: "تم تعديل السجل بعد تحديث الذكاء الاصطناعي. لن أقوم بالكتابة فوق التغيير الأحدث تلقائيًا.",
    pt: "O registro foi alterado após a atualização da IA. Não vou sobrescrever automaticamente a alteração mais recente.",
    fr: "L'enregistrement a été modifié après la mise à jour par l'IA. Je ne vais pas écraser automatiquement le changement plus récent.",
    es: "El registro se modificó después de la actualización de la IA. No sobrescribiré automáticamente el cambio más reciente.",
  },
  "rollback.conflict.dependency": {
    en: "The record has dependent data that would be corrupted by rollback. I cannot undo this safely.",
    ar: "السجل مرتبط ببيانات أخرى قد تتلف لو تم التراجع. لا يمكنني التراجع بأمان.",
    pt: "O registro tem dados dependentes que seriam corrompidos pelo desfazer. Não posso desfazer com segurança.",
    fr: "L'enregistrement a des données dépendantes qui seraient corrompues par l'annulation. Je ne peux pas annuler en toute sécurité.",
    es: "El registro tiene datos dependientes que se corromperían al deshacer. No puedo deshacer de forma segura.",
  },
  "rollback.conflict.expired": {
    en: "The undo window has closed for this change.",
    ar: "انتهت نافذة التراجع لهذا التعديل.",
    pt: "A janela de desfazer expirou para esta alteração.",
    fr: "La fenêtre d'annulation est fermée pour ce changement.",
    es: "La ventana de deshacer se cerró para este cambio.",
  },
  "rollback.conflict.alreadyReverted": {
    en: "This change has already been undone.",
    ar: "تم التراجع عن هذا التعديل بالفعل.",
    pt: "Esta alteração já foi desfeita.",
    fr: "Ce changement a déjà été annulé.",
    es: "Este cambio ya se deshizo.",
  },
  "rollback.conflict.entityMissing": {
    en: "The target record no longer exists.",
    ar: "السجل المستهدف لم يعد موجودًا.",
    pt: "O registro alvo não existe mais.",
    fr: "L'enregistrement cible n'existe plus.",
    es: "El registro objetivo ya no existe.",
  },
  "rollback.conflict.notReversible": {
    en: "This operation was not recorded as reversible.",
    ar: "لم تُسجَّل هذه العملية باعتبارها قابلة للتراجع.",
    pt: "Esta operação não foi registrada como reversível.",
    fr: "Cette opération n'a pas été enregistrée comme réversible.",
    es: "Esta operación no se registró como reversible.",
  },
  "rollback.conflict.writeFailed": {
    en: "The restore write failed. The record is unchanged.",
    ar: "فشلت عملية استعادة القيمة. السجل لم يتغير.",
    pt: "A gravação de restauração falhou. O registro permanece inalterado.",
    fr: "L'écriture de restauration a échoué. L'enregistrement est inchangé.",
    es: "Falló la escritura de restauración. El registro no cambió.",
  },
  "rollback.conflict.generic": {
    en: "I couldn't undo this change.",
    ar: "لم أتمكن من التراجع عن هذا التعديل.",
    pt: "Não consegui desfazer esta alteração.",
    fr: "Je n'ai pas pu annuler ce changement.",
    es: "No pude deshacer este cambio.",
  },

  "rollback.invalidParams": {
    en: "Missing operation reference for undo.",
    ar: "لا يوجد معرف عملية للتراجع.",
    pt: "Falta a referência da operação para desfazer.",
    fr: "Référence d'opération manquante pour annuler.",
    es: "Falta la referencia de la operación para deshacer.",
  },
  "rollback.operationMissing": {
    en: "That operation couldn't be found or you don't have access to it.",
    ar: "لم يتم العثور على العملية أو ليس لديك صلاحية الوصول إليها.",
    pt: "Operação não encontrada ou sem acesso.",
    fr: "Opération introuvable ou accès refusé.",
    es: "Operación no encontrada o sin acceso.",
  },
  "rollback.forbidden": {
    en: "You don't have permission to undo this operation.",
    ar: "ليس لديك الصلاحية للتراجع عن هذه العملية.",
    pt: "Você não tem permissão para desfazer esta operação.",
    fr: "Vous n'avez pas la permission d'annuler cette opération.",
    es: "No tienes permiso para deshacer esta operación.",
  },

  "rollback.nothingToUndo": {
    en: "I couldn't find a recent AI change in this conversation that I can undo.",
    ar: "لم أجد تعديلًا حديثًا للذكاء الاصطناعي في هذه المحادثة يمكنني التراجع عنه.",
    pt: "Não encontrei uma alteração recente de IA nesta conversa que eu possa desfazer.",
    fr: "Je n'ai pas trouvé de modification IA récente dans cette conversation que je puisse annuler.",
    es: "No encontré un cambio reciente de IA en esta conversación que pueda deshacer.",
  },

  /* ─────────────── F10.1 — data import ─────────────── */

  "import.preview.title": {
    en: 'Import preview — "{file}"',
    ar: 'معاينة الاستيراد — "{file}"',
    pt: 'Pré-visualização — "{file}"',
    fr: 'Aperçu de l\'import — « {file} »',
    es: 'Vista previa — "{file}"',
  },
  "import.preview.description": {
    en: '{total} rows: {toCreate} new, {toUpdate} updates, {issues} need attention.',
    ar: '{total} صف: {toCreate} جديد، {toUpdate} تحديث، {issues} يحتاج متابعة.',
    pt: '{total} linhas: {toCreate} novas, {toUpdate} atualizações, {issues} precisam de atenção.',
    fr: '{total} lignes : {toCreate} nouvelles, {toUpdate} mises à jour, {issues} à vérifier.',
    es: '{total} filas: {toCreate} nuevas, {toUpdate} actualizaciones, {issues} necesitan atención.',
  },
  "import.preview.actionLabel": {
    en: "Confirm import",
    ar: "تأكيد الاستيراد",
    pt: "Confirmar importação",
    fr: "Confirmer l'import",
    es: "Confirmar importación",
  },
  "import.preview.descriptionFull": {
    en: "I parsed {total} rows: {toCreate} new, {toUpdate} updates, {issues} need attention. Edit any row below, then confirm.",
    ar: "قرأت {total} صف: {toCreate} جديد، {toUpdate} تحديث، {issues} يحتاج متابعة. عدّل أي صف بالأسفل ثم أكّد.",
    pt: "Analisei {total} linhas: {toCreate} novas, {toUpdate} atualizações, {issues} precisam de atenção. Edite qualquer linha e confirme.",
    fr: "J'ai analysé {total} lignes : {toCreate} nouvelles, {toUpdate} mises à jour, {issues} à vérifier. Modifiez puis confirmez.",
    es: "Analicé {total} filas: {toCreate} nuevas, {toUpdate} actualizaciones, {issues} necesitan atención. Edita y confirma.",
  },
  "import.column.name": {
    en: "Name", ar: "الاسم", pt: "Nome", fr: "Nom", es: "Nombre",
  },
  "import.column.sku": {
    en: "SKU", ar: "SKU", pt: "SKU", fr: "SKU", es: "SKU",
  },
  "import.column.brand": {
    en: "Brand", ar: "البراند", pt: "Marca", fr: "Marque", es: "Marca",
  },
  "import.column.category": {
    en: "Category", ar: "التصنيف", pt: "Categoria", fr: "Catégorie", es: "Categoría",
  },
  "import.column.price": {
    en: "Price", ar: "السعر", pt: "Preço", fr: "Prix", es: "Precio",
  },
  "import.column.costPrice": {
    en: "Cost", ar: "التكلفة", pt: "Custo", fr: "Coût", es: "Costo",
  },
  "import.column.wholesalePrice": {
    en: "Wholesale", ar: "سعر الجملة", pt: "Atacado", fr: "Gros", es: "Mayorista",
  },
  "import.column.quantity": {
    en: "Qty", ar: "الكمية", pt: "Qtd", fr: "Qté", es: "Cant.",
  },
  "import.column.lowStockThreshold": {
    en: "Low-stock", ar: "حد التنبيه", pt: "Baixo estoque", fr: "Seuil bas", es: "Umbral bajo",
  },
  "import.column.barcode": {
    en: "Barcode", ar: "الباركود", pt: "Código barras", fr: "Code-barres", es: "Código de barras",
  },
  "import.column.description": {
    en: "Description", ar: "الوصف", pt: "Descrição", fr: "Description", es: "Descripción",
  },
  "import.question.title": {
    en: "Import needs clarification",
    ar: "الاستيراد يحتاج توضيحًا",
    pt: "A importação precisa de esclarecimento",
    fr: "L'import nécessite des précisions",
    es: "La importación necesita aclaración",
  },
  "import.question.missingWholesale": {
    en: "{n} products are missing the wholesale price. How should I proceed?",
    ar: "{n} منتج بدون سعر الجملة. كيف تريد المتابعة؟",
    pt: "{n} produtos sem preço de atacado. Como prosseguir?",
    fr: "{n} produits sans prix de gros. Comment procéder ?",
    es: "{n} productos sin precio mayorista. ¿Cómo proceder?",
  },
  "import.result.title": {
    en: 'Import completed — "{file}"',
    ar: 'اكتمل الاستيراد — "{file}"',
    pt: 'Importação concluída — "{file}"',
    fr: 'Import terminé — « {file} »',
    es: 'Importación completada — "{file}"',
  },
  "import.result.message": {
    en: "Created {created}, updated {updated}, skipped {skipped}, failed {failed}.",
    ar: "تم إنشاء {created}، تحديث {updated}، تخطي {skipped}، فشل {failed}.",
    pt: "Criados {created}, atualizados {updated}, ignorados {skipped}, falharam {failed}.",
    fr: "{created} créés, {updated} mis à jour, {skipped} ignorés, {failed} échoués.",
    es: "Creados {created}, actualizados {updated}, omitidos {skipped}, fallaron {failed}.",
  },
  "import.result.undoHint": {
    en: "You can say \"undo that import\" to revert this.",
    ar: "يمكنك قول \"تراجع عن الاستيراد\" لاسترجاع الحالة السابقة.",
    pt: "Diga \"desfaça essa importação\" para reverter.",
    fr: "Dites « annule cet import » pour revenir en arrière.",
    es: "Di \"deshaz esa importación\" para revertir.",
  },
  "import.conflict.title": {
    en: "Partial import rollback",
    ar: "تراجع جزئي عن الاستيراد",
    pt: "Reversão parcial da importação",
    fr: "Annulation partielle de l'import",
    es: "Reversión parcial de la importación",
  },
  "import.conflict.message": {
    en: "Reverted {reversed}; {conflicted} rows changed since the import and were kept; {failed} failed to roll back.",
    ar: "تم استعادة {reversed}؛ {conflicted} سجل تعرّض لتغيير بعد الاستيراد وتم الإبقاء عليها؛ {failed} فشلت.",
    pt: "Revertidas {reversed}; {conflicted} linhas mudaram após a importação e foram mantidas; {failed} falharam.",
    fr: "{reversed} rétablies ; {conflicted} lignes ont changé depuis l'import et ont été conservées ; {failed} échecs.",
    es: "Revertidas {reversed}; {conflicted} filas cambiaron después de la importación y se mantuvieron; {failed} fallaron.",
  },
  /* ─────────────── F10.3 — bulk operations ─────────────── */
  "bulk.preview.title": {
    en: "Bulk price update preview",
    ar: "معاينة تعديل الأسعار بالجملة",
    pt: "Pré-visualização de ajuste em massa",
    fr: "Aperçu de la mise à jour en masse",
    es: "Vista previa del cambio masivo",
  },
  "bulk.preview.description": {
    en: "{eligible} of {matched} products will be updated. Total net change: {totalDelta} EGP.",
    ar: "{eligible} من أصل {matched} منتج سيتم تحديثها. صافي التغيير: {totalDelta} ج.م.",
    pt: "{eligible} de {matched} produtos serão atualizados. Alteração total: {totalDelta} EGP.",
    fr: "{eligible} produits sur {matched} seront mis à jour. Variation totale : {totalDelta} EGP.",
    es: "{eligible} de {matched} productos se actualizarán. Cambio total: {totalDelta} EGP.",
  },
  "bulk.preview.actionLabel": {
    en: "Confirm bulk update",
    ar: "تأكيد التعديل بالجملة",
    pt: "Confirmar atualização em massa",
    fr: "Confirmer la mise à jour",
    es: "Confirmar actualización masiva",
  },
  "bulk.preview.overCap": {
    en: "Your filter matched {matched} products but only the first {cap} will be processed — narrow the filter to proceed with the rest.",
    ar: "اختيارك يشمل {matched} منتج لكن سيتم معالجة أول {cap} فقط — ضيّق الفلتر لتضمين الباقي.",
    pt: "O filtro corresponde a {matched} produtos, mas apenas os primeiros {cap} serão processados.",
    fr: "Votre filtre couvre {matched} produits, seuls les {cap} premiers seront traités.",
    es: "El filtro coincide con {matched} productos; solo los primeros {cap} se procesarán.",
  },
  "bulk.result.title": {
    en: "Bulk update complete",
    ar: "اكتمل التعديل بالجملة",
    pt: "Atualização em massa concluída",
    fr: "Mise à jour en masse terminée",
    es: "Actualización masiva completada",
  },
  "bulk.result.message": {
    en: "Updated {updated}, skipped {skipped}, failed {failed}.",
    ar: "تم تحديث {updated}، تخطي {skipped}، فشل {failed}.",
    pt: "Atualizados {updated}, ignorados {skipped}, falharam {failed}.",
    fr: "{updated} mis à jour, {skipped} ignorés, {failed} échoués.",
    es: "Actualizados {updated}, omitidos {skipped}, fallaron {failed}.",
  },
  "bulk.invalid": {
    en: "Bulk update rejected: {reason}",
    ar: "تم رفض التعديل بالجملة: {reason}",
    pt: "Atualização em massa rejeitada: {reason}",
    fr: "Mise à jour en masse rejetée : {reason}",
    es: "Actualización masiva rechazada: {reason}",
  },
  "bulk.nothingToDo": {
    en: "No products matched your filter. Nothing to update.",
    ar: "لم يتطابق أي منتج مع الفلتر. لا شيء للتحديث.",
    pt: "Nenhum produto corresponde ao filtro. Nada a atualizar.",
    fr: "Aucun produit ne correspond au filtre. Rien à mettre à jour.",
    es: "Ningún producto coincide con el filtro. Nada que actualizar.",
  },

  "import.unauthorized": {
    en: "You don't have permission to import this entity.",
    ar: "ليس لديك صلاحية استيراد هذا النوع من البيانات.",
    pt: "Você não tem permissão para importar esta entidade.",
    fr: "Vous n'avez pas la permission d'importer cette entité.",
    es: "No tienes permiso para importar esta entidad.",
  },
  "import.sessionMissing": {
    en: "That import session couldn't be found.",
    ar: "لم يتم العثور على جلسة الاستيراد.",
    pt: "Sessão de importação não encontrada.",
    fr: "Session d'import introuvable.",
    es: "No se encontró la sesión de importación.",
  },

  "operation.recordFailed.title": {
    en: "Undo unavailable for this change",
    ar: "لا يمكن التراجع عن هذا التغيير",
    pt: "Não é possível desfazer esta alteração",
    fr: "Impossible d'annuler ce changement",
    es: "No se puede deshacer este cambio",
  },
  "operation.recordFailed.message": {
    en: "The change was applied but could not be recorded for undo. Ops should be notified to reconcile manually.",
    ar: "تم تطبيق التغيير لكن تعذر تسجيله للتراجع. يُنصح بإبلاغ فريق التشغيل.",
    pt: "A alteração foi aplicada, mas não pôde ser registrada para desfazer. Avise a equipe de operações.",
    fr: "Le changement a été appliqué mais n'a pas pu être enregistré pour annulation. Informez l'équipe d'exploitation.",
    es: "El cambio se aplicó pero no pudo registrarse para deshacer. Avise al equipo de operaciones.",
  },

  /* ─────────────── F9 — knowledge / RAG ─────────────── */

  "knowledge.noEvidence": {
    en: "I couldn't find enough information in the available company documents to answer that.",
    ar: "لم أجد في وثائق الشركة المتاحة معلومات كافية للإجابة على سؤالك.",
    pt: "Não encontrei informações suficientes nos documentos da empresa para responder.",
    fr: "Je n'ai pas trouvé assez d'informations dans les documents de l'entreprise pour répondre.",
    es: "No encontré información suficiente en los documentos de la empresa para responder.",
  },
  "knowledge.sourcesLabel": {
    en: "Sources",
    ar: "المصادر",
    pt: "Fontes",
    fr: "Sources",
    es: "Fuentes",
  },

  "nudge.noResult": {
    en: "No result to show. Try rephrasing the question.",
    ar: "لم أحصل على نتيجة. حاول صياغة السؤال بشكل مختلف.",
    pt: "Sem resultado a mostrar. Tente reformular a pergunta.",
    fr: "Aucun résultat à afficher. Essayez de reformuler votre question.",
    es: "No hay resultado que mostrar. Intenta reformular la pregunta.",
  },

  "nudge.sanitised": {
    en: "I couldn't format that response. Try rephrasing the question.",
    ar: "لم أتمكن من عرض الرد بالشكل الصحيح. حاول صياغة السؤال مرة أخرى.",
    pt: "Não consegui formatar essa resposta. Tente reformular a pergunta.",
    fr: "Je n'ai pas pu mettre en forme cette réponse. Essayez de reformuler.",
    es: "No pude dar formato a esa respuesta. Intenta reformular la pregunta.",
  },

  /* ─────────────── context block header + hints ─────────────── */

  "context.header": {
    en: "ACTIVE CONVERSATION CONTEXT:",
    ar: "السياق النشط للمحادثة:",
    pt: "CONTEXTO ATIVO DA CONVERSA:",
    fr: "CONTEXTE ACTIF DE LA CONVERSATION :",
    es: "CONTEXTO ACTIVO DE LA CONVERSACIÓN:",
  },
  "context.candidateHeader": {
    en: 'Last product result set ({n}) from search "{query}":',
    ar: 'آخر قائمة منتجات ({n}) من البحث "{query}":',
    pt: 'Último conjunto de resultados ({n}) da busca "{query}":',
    fr: 'Dernier jeu de résultats produit ({n}) de la recherche « {query} » :',
    es: 'Último conjunto de resultados ({n}) de la búsqueda "{query}":',
  },
  "context.selected": {
    en: "Currently selected: {name} (uuid={uuid})",
    ar: "المنتج المختار حاليًا: {name} (uuid={uuid})",
    pt: "Atualmente selecionado: {name} (uuid={uuid})",
    fr: "Actuellement sélectionné : {name} (uuid={uuid})",
    es: "Actualmente seleccionado: {name} (uuid={uuid})",
  },
  "context.lastWrite": {
    en: "Last write: {name} · {field} {before} → {after}",
    ar: "آخر تعديل: {name} · {field} من {before} إلى {after}",
    pt: "Última gravação: {name} · {field} {before} → {after}",
    fr: "Dernière écriture : {name} · {field} {before} → {after}",
    es: "Última escritura: {name} · {field} {before} → {after}",
  },
  "context.hintResolved": {
    en: "HINT: the user's reference in this message most likely points at uuid={uuid} ({reason}).",
    ar: "تلميح: إشارة المستخدم في هذه الرسالة على الأرجح تعني uuid={uuid} ({reason}).",
    pt: "DICA: a referência do usuário nesta mensagem provavelmente aponta para uuid={uuid} ({reason}).",
    fr: "INDICE : la référence de l'utilisateur dans ce message pointe très probablement vers uuid={uuid} ({reason}).",
    es: "PISTA: la referencia del usuario en este mensaje probablemente apunta a uuid={uuid} ({reason}).",
  },
  "context.hintAmbiguous": {
    en: "HINT: the user's reference is ambiguous ({reason}) — ask them which one BEFORE calling any preview_*.",
    ar: "تلميح: إشارة المستخدم غامضة ({reason}) — اسأله أيهما يقصد قبل أي preview.",
    pt: "DICA: a referência do usuário está ambígua ({reason}) — pergunte qual deles ANTES de chamar qualquer preview_*.",
    fr: "INDICE : la référence de l'utilisateur est ambiguë ({reason}) — demandez-lui laquelle AVANT tout preview_*.",
    es: "PISTA: la referencia del usuario es ambigua ({reason}) — pregúntale cuál antes de llamar a cualquier preview_*.",
  },
  "context.ruleUuid": {
    en: "Rule: you MUST use the real uuid from this context for any tool call. Never invent a uuid.",
    ar: "قاعدة: لازم تستخدم الـ uuid الحقيقي من هذا السياق لأي مكالمة أداة. ممنوع تخترع uuid.",
    pt: "Regra: VOCÊ DEVE usar o uuid real deste contexto em qualquer chamada de ferramenta. Nunca invente um uuid.",
    fr: "Règle : vous DEVEZ utiliser le vrai uuid de ce contexte pour toute invocation d'outil. N'inventez jamais un uuid.",
    es: "Regla: DEBES usar el uuid real de este contexto en cualquier llamada a herramienta. Nunca inventes un uuid.",
  },

  /* ─────────────── identity + prompt scaffolding ─────────────── */

  "prompt.identity": {
    en: "You are 'Amr', the smart assistant for the shop owner inside the Matgary (Storo) POS app.",
    ar: "أنت 'عمرو'، مساعد ذكي لصاحب المتجر داخل تطبيق متجري (Storo).",
    pt: "Você é 'Amr', o assistente inteligente do dono da loja dentro do app Matgary (Storo) POS.",
    fr: "Vous êtes « Amr », l'assistant intelligent du gérant dans l'application Matgary (Storo) POS.",
    es: "Eres 'Amr', el asistente inteligente del dueño de la tienda dentro de la app Matgary (Storo) POS.",
  },
  "prompt.scope.branch": {
    en: "Scope: the active branch only.",
    ar: "النطاق: الفرع النشط فقط.",
    pt: "Escopo: apenas a filial ativa.",
    fr: "Portée : uniquement la succursale active.",
    es: "Alcance: solo la sucursal activa.",
  },
  "prompt.scope.allBranches": {
    en: "Scope: every branch aggregated.",
    ar: "النطاق: كل الفروع مجمعة.",
    pt: "Escopo: todas as filiais agregadas.",
    fr: "Portée : toutes les succursales agrégées.",
    es: "Alcance: todas las sucursales agregadas.",
  },
  /* ─────────────── Phase 7-13 — Financials + receipt confirmations ─────────────── */
  "write.expense.title": {
    en: 'Record expense "{title}"',
    ar: 'تسجيل مصروف "{title}"',
    pt: 'Registrar despesa "{title}"',
    fr: 'Enregistrer la dépense « {title} »',
    es: 'Registrar gasto "{title}"',
  },
  "write.expense.actionLabel": {
    en: "Confirm expense",
    ar: "تأكيد المصروف",
    pt: "Confirmar despesa",
    fr: "Confirmer la dépense",
    es: "Confirmar gasto",
  },
  "write.voidExpense.title": {
    en: "Void expense",
    ar: "إلغاء مصروف",
    pt: "Anular despesa",
    fr: "Annuler la dépense",
    es: "Anular gasto",
  },
  "write.voidExpense.summary": {
    en: "Expense {id}… will be excluded from P&L.",
    ar: "المصروف {id}… سيتم استبعاده من الأرباح والخسائر.",
    pt: "Despesa {id}… será excluída do P&L.",
    fr: "La dépense {id}… sera exclue du P&L.",
    es: "Gasto {id}… quedará excluido del P&L.",
  },
  "write.voidExpense.actionLabel": {
    en: "Confirm void",
    ar: "تأكيد الإلغاء",
    pt: "Confirmar anulação",
    fr: "Confirmer l’annulation",
    es: "Confirmar anulación",
  },
  "write.moneyMovement.title": {
    en: "Record money movement (not P&L)",
    ar: "تسجيل حركة مالية (ليست ربح/خسارة)",
    pt: "Registrar movimento financeiro (não é P&L)",
    fr: "Enregistrer un mouvement de trésorerie (hors P&L)",
    es: "Registrar movimiento de dinero (no P&L)",
  },
  "write.moneyMovement.actionLabel": {
    en: "Confirm movement",
    ar: "تأكيد الحركة",
    pt: "Confirmar movimento",
    fr: "Confirmer le mouvement",
    es: "Confirmar movimiento",
  },
  "write.voidMoneyMovement.title": {
    en: "Void money movement",
    ar: "إلغاء حركة مالية",
    pt: "Anular movimento",
    fr: "Annuler le mouvement",
    es: "Anular movimiento",
  },
  "write.voidMoneyMovement.summary": {
    en: "Movement {id}… will be voided.",
    ar: "الحركة {id}… سيتم إلغاؤها.",
    pt: "Movimento {id}… será anulado.",
    fr: "Le mouvement {id}… sera annulé.",
    es: "El movimiento {id}… quedará anulado.",
  },
  "write.voidMoneyMovement.actionLabel": {
    en: "Confirm void",
    ar: "تأكيد الإلغاء",
    pt: "Confirmar anulação",
    fr: "Confirmer l’annulation",
    es: "Confirmar anulación",
  },
  "write.financeCategory.title": {
    en: "Create expense category",
    ar: "إنشاء تصنيف مصروفات",
    pt: "Criar categoria de despesa",
    fr: "Créer une catégorie de dépenses",
    es: "Crear categoría de gastos",
  },
  "write.financeCategory.actionLabel": {
    en: "Confirm category",
    ar: "تأكيد التصنيف",
    pt: "Confirmar categoria",
    fr: "Confirmer la catégorie",
    es: "Confirmar categoría",
  },
  "write.archiveFinanceCategory.title": {
    en: "Archive expense category",
    ar: "أرشفة تصنيف مصروفات",
    pt: "Arquivar categoria",
    fr: "Archiver la catégorie",
    es: "Archivar categoría",
  },
  "write.archiveFinanceCategory.summary": {
    en: "Category {id}… will be archived (fails if live expenses still use it).",
    ar: "التصنيف {id}… سيتم أرشفته (يفشل إذا كان مستخدمًا في مصروفات نشطة).",
    pt: "Categoria {id}… será arquivada.",
    fr: "La catégorie {id}… sera archivée.",
    es: "La categoría {id}… quedará archivada.",
  },
  "write.archiveFinanceCategory.actionLabel": {
    en: "Confirm archive",
    ar: "تأكيد الأرشفة",
    pt: "Confirmar arquivamento",
    fr: "Confirmer l’archivage",
    es: "Confirmar archivo",
  },
  "write.generateRecurring.title": {
    en: "Generate recurring expenses",
    ar: "إنشاء المصروفات المتكررة المستحقة",
    pt: "Gerar despesas recorrentes",
    fr: "Générer les dépenses récurrentes",
    es: "Generar gastos recurrentes",
  },
  "write.generateRecurring.summary": {
    en: "All due recurring templates will be spawned (idempotent).",
    ar: "سيتم إنشاء كل القوالب المستحقة (آمنة للتكرار).",
    pt: "Todos os modelos devidos serão gerados.",
    fr: "Tous les modèles dus seront créés.",
    es: "Se generarán todas las plantillas vencidas.",
  },
  "write.generateRecurring.actionLabel": {
    en: "Confirm generate",
    ar: "تأكيد الإنشاء",
    pt: "Confirmar geração",
    fr: "Confirmer la génération",
    es: "Confirmar generación",
  },
  "write.receiptSettings.title": {
    en: "Update receipt settings",
    ar: "تحديث إعدادات الفاتورة",
    pt: "Atualizar configurações do recibo",
    fr: "Mettre à jour les paramètres du reçu",
    es: "Actualizar ajustes del recibo",
  },
  "write.receiptSettings.summary": {
    en: "The receipt will use the new identity fields immediately. Historical sales are unaffected.",
    ar: "ستستخدم الفاتورة البيانات الجديدة فورًا. المبيعات السابقة لن تتأثر.",
    pt: "O recibo usará os novos campos. Vendas históricas não são afetadas.",
    fr: "Le reçu utilisera les nouveaux champs immédiatement. Les ventes historiques ne sont pas affectées.",
    es: "El recibo usará los nuevos campos inmediatamente. Las ventas anteriores no se verán afectadas.",
  },
  "write.receiptSettings.actionLabel": {
    en: "Confirm settings",
    ar: "تأكيد الإعدادات",
    pt: "Confirmar ajustes",
    fr: "Confirmer les paramètres",
    es: "Confirmar ajustes",
  },
  "execute.unexpected": {
    en: "Unexpected error. Try again or contact support.",
    ar: "حدث خطأ غير متوقع. حاول مجددًا أو تواصل مع الدعم.",
    pt: "Erro inesperado. Tente novamente ou contate o suporte.",
    fr: "Erreur inattendue. Réessayez ou contactez le support.",
    es: "Error inesperado. Intenta de nuevo o contacta soporte.",
  },
  /* ────────── Tasks ────────── */
  "write.task.title": {
    en: 'Create task "{title}"',
    ar: 'إنشاء مهمة "{title}"',
    pt: 'Criar tarefa "{title}"',
    fr: 'Créer la tâche « {title} »',
    es: 'Crear tarea "{title}"',
  },
  "write.task.actionLabel": {
    en: "Confirm task",
    ar: "تأكيد المهمة",
    pt: "Confirmar tarefa",
    fr: "Confirmer la tâche",
    es: "Confirmar tarea",
  },
  "write.taskUpdate.title": {
    en: "Update task",
    ar: "تعديل مهمة",
    pt: "Atualizar tarefa",
    fr: "Mettre à jour la tâche",
    es: "Actualizar tarea",
  },
  "write.taskUpdate.summary": {
    en: "Task {id}… — changing: {fields}.",
    ar: "المهمة {id}… — تغيير: {fields}.",
    pt: "Tarefa {id}… — alterando: {fields}.",
    fr: "Tâche {id}… — modifications : {fields}.",
    es: "Tarea {id}… — cambiando: {fields}.",
  },
  "write.taskUpdate.actionLabel": {
    en: "Confirm update",
    ar: "تأكيد التعديل",
    pt: "Confirmar atualização",
    fr: "Confirmer la mise à jour",
    es: "Confirmar actualización",
  },
  "write.taskStatus.title": {
    en: "Change task status",
    ar: "تغيير حالة مهمة",
    pt: "Mudar status da tarefa",
    fr: "Changer le statut de la tâche",
    es: "Cambiar estado de la tarea",
  },
  "write.taskStatus.summary": {
    en: "Task {id}… → {status}.",
    ar: "المهمة {id}… → {status}.",
    pt: "Tarefa {id}… → {status}.",
    fr: "Tâche {id}… → {status}.",
    es: "Tarea {id}… → {status}.",
  },
  "write.taskStatus.actionLabel": {
    en: "Confirm status",
    ar: "تأكيد الحالة",
    pt: "Confirmar status",
    fr: "Confirmer le statut",
    es: "Confirmar estado",
  },
};

/**
 * Look up a localized string. Returns:
 *  • the locale's string when present,
 *  • English fallback when the locale entry is missing,
 *  • the raw key (and a WARN log) when the key is unknown — a last-ditch
 *    visibility signal so a dev can see the gap in dev builds.
 */
export function tr(
  key: string,
  locale: Locale,
  vars: Record<string, string | number> = {},
): string {
  const entry = MESSAGES[key];
  if (!entry) {
    console.warn("[ai/i18n] missing key", { key, locale });
    return interpolate(key, vars);
  }
  const value = entry[locale] ?? entry.en;
  if (value === undefined) {
    console.warn("[ai/i18n] missing locale + fallback", { key, locale });
    return interpolate(key, vars);
  }
  return interpolate(value, vars);
}

/** Export the message table for tests / introspection. Do not mutate. */
export const AI_MESSAGES = MESSAGES as Readonly<typeof MESSAGES>;
