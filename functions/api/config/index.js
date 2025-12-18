// functions/api/config/index.js
import { isAdminAuthenticated, errorResponse, jsonResponse, normalizeSortOrder } from '../../_middleware';

let indexesChecked = false;

export async function onRequestGet(context) {
  const { request, env } = context;
  
  // 自动确保索引存在（每个 Worker 实例只执行一次）
  if (!indexesChecked) {
    try {
      await env.NAV_DB.batch([
        env.NAV_DB.prepare("CREATE INDEX IF NOT EXISTS idx_sites_catelog_id ON sites(catelog_id)"),
        env.NAV_DB.prepare("CREATE INDEX IF NOT EXISTS idx_sites_sort_order ON sites(sort_order)")
      ]);
      indexesChecked = true;
    } catch (e) {
      console.error('Failed to ensure indexes:', e);
      // 继续执行，不要因为索引创建失败而阻塞主逻辑
    }
  }

  const url = new URL(request.url);
  
  const catalog = url.searchParams.get('catalog');
  const catalogId = url.searchParams.get('catalogId');
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const pageSize = parseInt(url.searchParams.get('pageSize') || '10', 10);
  const keyword = url.searchParams.get('keyword');
  const offset = (page - 1) * pageSize;

  try {
    let query = `SELECT s.*,c.catelog FROM sites s
                 INNER JOIN category c ON s.catelog_id = c.id
                 ORDER BY s.sort_order ASC, s.create_time DESC LIMIT ? OFFSET ? `;
    let countQuery = 'SELECT COUNT(*) as total FROM sites';
    let queryBindParams = [pageSize, offset];
    let countQueryParams = [];

    if (catalogId) {
      query = `SELECT s.*,c.catelog FROM sites s
               INNER JOIN category c ON s.catelog_id = c.id
               WHERE s.catelog_id = ? ORDER BY s.sort_order ASC, s.create_time DESC LIMIT ? OFFSET ?`;
      countQuery = `SELECT COUNT(*) as total FROM sites WHERE catelog_id = ?`;
      queryBindParams = [catalogId, pageSize, offset];
      countQueryParams = [catalogId];
    } else if (catalog) {
      console.log('catalog', catalog);
      query = `SELECT s.*,c.catelog FROM sites s
               INNER JOIN category c ON s.catelog_id = c.id
               WHERE c.catelog = ? ORDER BY s.sort_order ASC, s.create_time DESC LIMIT ? OFFSET ?`;
      countQuery = `SELECT COUNT(*) as total FROM sites s 
                    INNER JOIN category c ON s.catelog_id = c.id 
                    WHERE c.catelog = ?`;
      queryBindParams = [catalog, pageSize, offset];
      countQueryParams = [catalog];
    }

    if (keyword) {
      const likeKeyword = `%${keyword}%`;
      query = `SELECT s.*,c.catelog FROM sites s
               INNER JOIN category c ON s.catelog_id = c.id
               WHERE s.name LIKE ? OR s.url LIKE ? OR c.catelog LIKE ?
               ORDER BY s.sort_order ASC, s.create_time DESC LIMIT ? OFFSET ?`;
      countQuery = `SELECT COUNT(*) as total FROM sites s
                    INNER JOIN category c ON s.catelog_id = c.id
                    WHERE s.name LIKE ? OR s.url LIKE ? OR c.catelog LIKE ?`;
      queryBindParams = [likeKeyword, likeKeyword, likeKeyword, pageSize, offset];
      countQueryParams = [likeKeyword, likeKeyword, likeKeyword];

    }

    const { results } = await env.NAV_DB.prepare(query).bind(...queryBindParams).all();
    
    // 优化：如果 pageSize 很大（通常是“获取全部”场景），则跳过 COUNT 查询
    // 这种情况下，客户端通常不需要精确的总数来进行分页
    let total = 0;
    if (pageSize >= 1000) {
        total = results.length + offset; // 返回当前页结果数加上偏移量
    } else {
        const countResult = await env.NAV_DB.prepare(countQuery).bind(...countQueryParams).first();
        total = countResult ? countResult.total : 0;
    }

    return jsonResponse({
      code: 200,
      data: results,
      total,
      page,
      pageSize
    });
  } catch (e) {
    return errorResponse(`Failed to fetch config data: ${e.message}`, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  
  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const config = await request.json();
    const { name, url, logo, desc, catelogId, sort_order } = config;
    const iconAPI=env.ICON_API ||'https://favicon.im/';
    
    const sanitizedName = (name || '').trim();
    const sanitizedUrl = (url || '').trim();
    let sanitizedLogo = (logo || '').trim() || null;
    const sanitizedDesc = (desc || '').trim() || null;
    const sortOrderValue = normalizeSortOrder(sort_order);

    if (!sanitizedName || !sanitizedUrl || !catelogId) {
      return errorResponse('Name, URL and Catelog are required', 400);
    }
    if(!logo && url){
      if(url.startsWith('https://') || url.startsWith('http://')){
        const domain = url.replace(/^https?:\/\//, '').split('/')[0];
        sanitizedLogo = iconAPI+domain;
        if(!env.ICON_API){
          sanitizedLogo+='?larger=true'
      }
    }
      
    }
    // Find the category ID from the category name
    const categoryResult = await env.NAV_DB.prepare('SELECT catelog FROM category WHERE id = ?').bind(catelogId).first();

    if (!categoryResult) {
      return errorResponse(`Category not found.`, 400);
    }
    const insert = await env.NAV_DB.prepare(`
      INSERT INTO sites (name, url, logo, desc, catelog_id, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(sanitizedName, sanitizedUrl, sanitizedLogo, sanitizedDesc, catelogId, sortOrderValue).run();

    return jsonResponse({
      code: 201,
      message: 'Config created successfully',
      insert
    }, 201);
  } catch (e) {
    return errorResponse(`Failed to create config: ${e.message}`, 500);
  }
}
